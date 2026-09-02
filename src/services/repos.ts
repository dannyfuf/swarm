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
  StatePort,
} from "../core/ports.ts";
import type { OnEvent, RepoService, WorktreeService } from "../core/services.ts";
import type { Config, RemoteRepo, Repo, State } from "../core/types.ts";
import { mutateState } from "./stateMutation.ts";

export interface RepoServiceDependencies {
  state: StatePort;
  config: ConfigPort;
  github: GithubPort;
  git: GitPort;
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

      const cloned = new Set(current.repos.map((repo) => repo.id));
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
      let staging: string | undefined;
      let cloneStarted = false;
      try {
        const repo = await mutateState(state, async (next) => {
          if (!next.contexts.some((context) => context.id === contextId)) {
            throw new SwarmError("not-found", `Context not found: ${contextId}`);
          }

          const id = makeRepoId(remote.owner, remote.name);
          if (next.repos.some((repo) => repo.id === id)) {
            throw new SwarmError("conflict", `Repository already exists: ${id}`);
          }

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
          try {
            if (await files.exists(destination)) {
              throw new SwarmError("conflict", `Repository path already exists: ${destination}`);
            }
            await files.ensureDir(dirname(destination));
          } catch (error) {
            throw toSwarmError(error, "fs", `Failed to inspect repository path: ${destination}`);
          }

          staging = `${destination}.staging-${process.pid}-${randomUUID()}`;
          onEvent?.({ type: "step", label: "Cloning" });
          cloneStarted = true;
          try {
            await git.clone(cloneUrl, staging, {
              onProgress: (line) => onEvent?.({ type: "log", line }),
            });
          } catch (error) {
            throw toSwarmError(error, "git", `Failed to clone repository: ${id}`);
          }

          let defaultBranch: string;
          try {
            defaultBranch = await git.defaultBranch(staging);
          } catch (error) {
            throw toSwarmError(error, "git", `Failed to detect the default branch for: ${id}`);
          }

          try {
            await files.move(staging, destination);
            staging = undefined;
          } catch (error) {
            throw toSwarmError(error, "fs", `Failed to install cloned repository: ${id}`);
          }

          const created: Repo = {
            id,
            owner: remote.owner,
            name: remote.name,
            url: cloneUrl,
            contextId,
            defaultBranch,
            path: destination,
            clonedAt: clock.now().toISOString(),
            hooks: { postCreate: [] },
          };
          next.repos.push(created);
          return created;
        });
        onEvent?.({ type: "done" });
        return repo;
      } catch (error) {
        const failure =
          error instanceof SwarmError
            ? error
            : new SwarmError("git", "Failed to clone repository", { cause: error });
        if (cloneStarted && staging) {
          try {
            await files.removeDetached(staging);
          } catch (cleanupError) {
            logger.error("Failed to clean up a partial repository clone", cleanupError);
          }
        }
        onEvent?.({ type: "error", error: failure });
        throw failure;
      }
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
