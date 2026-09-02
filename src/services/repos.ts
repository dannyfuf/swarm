import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { SwarmError } from "../core/errors.ts";
import { fuzzyFilter } from "../core/fuzzy.ts";
import { repoId as makeRepoId, repoPath } from "../core/paths.ts";
import type {
  Clock,
  ConfigPort,
  FilesPort,
  GithubPort,
  GitPort,
  Logger,
  ProcessPort,
  StatePort,
} from "../core/ports.ts";
import type { OnEvent, RepoService, WorktreeService } from "../core/services.ts";
import type { CloneJob, Config, RemoteRepo, Repo, State } from "../core/types.ts";
import { mutateState } from "./stateMutation.ts";

export interface RepoServiceDependencies {
  state: StatePort;
  config: ConfigPort;
  github: GithubPort;
  git: GitPort;
  process: ProcessPort;
  files: FilesPort;
  worktreeService: WorktreeService;
  clock: Clock;
  logger: Logger;
  home?: string;
}

function toSwarmError(error: unknown, code: "fs" | "git" | "github", message: string): SwarmError {
  return error instanceof SwarmError ? error : new SwarmError(code, message, { cause: error });
}

function forwardProgress(onEvent?: OnEvent): OnEvent | undefined {
  if (!onEvent) return undefined;
  return (event) => {
    if (event.type === "step" || event.type === "log") onEvent(event);
  };
}

function isDescendant(path: string, root: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`);
}

function assertRepoPath(repo: Repo, config: Config): void {
  const expected = repoPath(config, repo.owner, repo.name);
  if (resolve(repo.path) !== resolve(expected) || !isDescendant(expected, config.reposDir)) {
    throw new SwarmError(
      "validation",
      `Refusing to delete repo with an invalid path: ${repo.path}`,
    );
  }
}

export function createRepoService({
  state,
  config,
  github,
  git,
  process,
  files,
  worktreeService,
  clock,
  logger,
  home,
}: RepoServiceDependencies): RepoService {
  const loadState = async (): Promise<State> => {
    try {
      return await state.load();
    } catch (error) {
      throw toSwarmError(error, "fs", "Failed to load swarm state");
    }
  };

  const service: RepoService = {
    async list(contextId) {
      const repos = (await loadState()).repos;
      return contextId === undefined ? repos : repos.filter((repo) => repo.contextId === contextId);
    },

    async searchRemote(contextId, query, opts = {}) {
      const current = await loadState();
      const context = current.contexts.find((candidate) => candidate.id === contextId);
      if (!context) throw new SwarmError("not-found", `Context not found: ${contextId}`);
      if (context.owners.length === 0) return [];

      const requests = context.owners.map((owner) => {
        const githubOptions = { signal: opts.signal, force: opts.refresh };
        return github.listRepos(owner, githubOptions);
      });
      const settled = await Promise.allSettled(requests);
      const failures = settled.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failures.length === settled.length) {
        throw toSwarmError(failures[0]?.reason, "github", "Failed to list remote repositories");
      }
      for (const failure of failures) {
        logger.warn("Skipping an owner whose repositories could not be listed", failure.reason);
      }

      const cloned = new Set([
        ...current.repos.map((repo) => repo.id),
        ...current.clones.filter((job) => job.status !== "failed").map((job) => job.id),
      ]);
      const available = settled.flatMap((result) =>
        result.status === "fulfilled"
          ? result.value.filter((remote) => !cloned.has(remote.fullName))
          : [],
      );
      return fuzzyFilter(query, available, (remote) => remote.fullName)
        .slice(0, 200)
        .map(({ item }) => item);
    },

    async clone(remote: RemoteRepo, contextId, onEvent) {
      const id = makeRepoId(remote.owner, remote.name);
      let job: CloneJob | undefined;
      try {
        let loadedConfig: Config;
        try {
          loadedConfig = await config.load();
        } catch (error) {
          throw toSwarmError(error, "fs", "Failed to load swarm configuration");
        }

        const destination = repoPath(loadedConfig, remote.owner, remote.name);
        const cloneUrl =
          loadedConfig.github.cloneProtocol === "https"
            ? `https://github.com/${remote.owner}/${remote.name}.git`
            : remote.sshUrl;
        const unique = randomUUID();
        const stagingPath = `${destination}.staging-${globalThis.process.pid}-${unique}`;
        const logsDir = join(home ?? dirname(loadedConfig.reposDir), "logs");
        const logPath = join(logsDir, `clone-${remote.owner}-${remote.name}-${unique}.log`);
        const previousFailure = (await loadState()).clones.find(
          (candidate) => candidate.id === id && candidate.status === "failed",
        );
        if (previousFailure) {
          await files.removeDetached(previousFailure.stagingPath).catch((error: unknown) => {
            logger.error("Failed to clean up the previous clone attempt", error);
          });
        }

        try {
          if (await files.exists(destination)) {
            throw new SwarmError("conflict", `Repository path already exists: ${destination}`);
          }
          await Promise.all([files.ensureDir(dirname(destination)), files.ensureDir(logsDir)]);
        } catch (error) {
          throw toSwarmError(error, "fs", `Failed to inspect repository path: ${destination}`);
        }

        job = await mutateState(state, (next) => {
          if (!next.contexts.some((context) => context.id === contextId)) {
            throw new SwarmError("not-found", `Context not found: ${contextId}`);
          }
          const existingClone = next.clones.find((candidate) => candidate.id === id);
          if (
            next.repos.some((repo) => repo.id === id) ||
            (existingClone !== undefined && existingClone.status !== "failed")
          ) {
            throw new SwarmError("conflict", `Repository already exists: ${id}`);
          }
          next.clones = next.clones.filter((candidate) => candidate.id !== id);
          const starting: CloneJob = {
            id,
            owner: remote.owner,
            name: remote.name,
            url: cloneUrl,
            contextId,
            defaultBranch: remote.defaultBranch,
            path: destination,
            stagingPath,
            logPath,
            startedAt: clock.now().toISOString(),
            status: "starting",
          };
          next.clones.push(starting);
          return starting;
        });

        onEvent?.({ type: "step", label: "Starting background clone" });
        const pid = await git.cloneDetached(cloneUrl, stagingPath, logPath);
        const launched = await mutateState(state, (next) => {
          const index = next.clones.findIndex((candidate) => candidate.id === id);
          const current = next.clones[index];
          if (!current) throw new SwarmError("not-found", `Clone job not found: ${id}`);
          const updated: CloneJob = { ...current, pid, status: "cloning" };
          next.clones[index] = updated;
          return updated;
        });
        onEvent?.({ type: "done" });
        return launched;
      } catch (error) {
        const failure =
          error instanceof SwarmError
            ? error
            : new SwarmError("git", "Failed to clone repository", { cause: error });
        if (job) {
          try {
            await mutateState(state, (next) => {
              const index = next.clones.findIndex((candidate) => candidate.id === job?.id);
              const current = next.clones[index];
              if (!current) return;
              next.clones[index] = { ...current, status: "failed", error: failure.message };
            });
          } catch (stateError) {
            logger.error("Failed to persist background clone failure", stateError);
          }
        }
        onEvent?.({ type: "error", error: failure });
        throw failure;
      }
    },

    async reconcileClones() {
      const current = await loadState();
      for (const clone of current.clones) {
        if (clone.status === "failed") continue;
        if (clone.pid !== undefined && (await process.isAlive(clone.pid))) continue;

        try {
          const stagingComplete = await files.exists(join(clone.stagingPath, ".git"));
          const installedComplete = await files.exists(join(clone.path, ".git"));
          const completedPath = stagingComplete
            ? clone.stagingPath
            : installedComplete
              ? clone.path
              : undefined;
          if (!completedPath) {
            const message = `Clone process exited before producing a valid repository; see ${clone.logPath}`;
            await mutateState(state, (next) => {
              const index = next.clones.findIndex((candidate) => candidate.id === clone.id);
              const existing = next.clones[index];
              if (existing) next.clones[index] = { ...existing, status: "failed", error: message };
            });
            await files.removeDetached(clone.stagingPath).catch((error: unknown) => {
              logger.error("Failed to clean up a partial repository clone", error);
            });
            continue;
          }

          const defaultBranch = await git.defaultBranch(completedPath, clone.defaultBranch);
          if (completedPath === clone.stagingPath) await files.move(clone.stagingPath, clone.path);
          await mutateState(state, (next) => {
            if (!next.repos.some((repo) => repo.id === clone.id)) {
              const created: Repo = {
                id: clone.id,
                owner: clone.owner,
                name: clone.name,
                url: clone.url,
                contextId: clone.contextId,
                defaultBranch,
                path: clone.path,
                clonedAt: clock.now().toISOString(),
                hooks: { postCreate: [] },
              };
              next.repos.push(created);
            }
            next.clones = next.clones.filter((candidate) => candidate.id !== clone.id);
          });
          logger.info("Background clone completed", { id: clone.id, path: clone.path });
        } catch (error) {
          const failure = toSwarmError(
            error,
            "git",
            `Failed to finish repository clone: ${clone.id}`,
          );
          const installed = await files.exists(join(clone.path, ".git")).catch(() => false);
          if (installed) {
            logger.error(`${failure.message}; reconciliation will retry`, failure);
            continue;
          }
          await mutateState(state, (next) => {
            const index = next.clones.findIndex((candidate) => candidate.id === clone.id);
            const existing = next.clones[index];
            if (existing) {
              next.clones[index] = { ...existing, status: "failed", error: failure.message };
            }
          });
          logger.error(failure.message, failure);
        }
      }
      return (await loadState()).clones;
    },

    async assign(repoId, contextId) {
      return mutateState(state, (next) => {
        const repoIndex = next.repos.findIndex((repo) => repo.id === repoId);
        const repo = next.repos[repoIndex];
        if (!repo) throw new SwarmError("not-found", `Repository not found: ${repoId}`);
        if (!next.contexts.some((context) => context.id === contextId)) {
          throw new SwarmError("not-found", `Context not found: ${contextId}`);
        }

        const updated = { ...repo, contextId };
        next.repos[repoIndex] = updated;
        return updated;
      });
    },

    async delete(repoId, onEvent) {
      let moved: { source: string; trash: string } | undefined;
      try {
        const trashPath = await mutateState(state, async (next) => {
          const repo = next.repos.find((candidate) => candidate.id === repoId);
          if (!repo) throw new SwarmError("not-found", `Repository not found: ${repoId}`);

          let loadedConfig: Config;
          try {
            loadedConfig = await config.load();
          } catch (error) {
            throw toSwarmError(error, "fs", "Failed to load swarm configuration");
          }
          assertRepoPath(repo, loadedConfig);

          const progress = forwardProgress(onEvent);
          for (const worktree of next.worktrees.filter(
            (candidate) => candidate.repoId === repoId,
          )) {
            await worktreeService.delete(worktree.id, progress);
          }

          const trashPath = join(
            home ?? dirname(loadedConfig.reposDir),
            "trash",
            `${clock.now().getTime()}-${repo.name}`,
          );
          try {
            await files.ensureDir(dirname(trashPath));
            await files.move(repo.path, trashPath);
            moved = { source: repo.path, trash: trashPath };
          } catch (error) {
            throw toSwarmError(error, "fs", `Failed to trash repository: ${repoId}`);
          }

          next.repos = next.repos.filter((candidate) => candidate.id !== repoId);
          return trashPath;
        });
        moved = undefined;
        await files.removeDetached(trashPath).catch((error: unknown) => {
          logger.error(`Failed to remove trashed repository: ${repoId}`, error);
        });
        onEvent?.({ type: "done" });
      } catch (error) {
        if (moved) {
          try {
            await files.move(moved.trash, moved.source);
          } catch (rollbackError) {
            logger.error(
              `Failed to restore repository after state failure: ${repoId}`,
              rollbackError,
            );
          }
        }
        const failure =
          error instanceof SwarmError
            ? error
            : new SwarmError("fs", `Failed to delete repository: ${repoId}`, { cause: error });
        onEvent?.({ type: "error", error: failure });
        throw failure;
      }
    },
  };

  return service;
}
