import { dirname, join, relative, resolve, sep } from "node:path";
import { SwarmError } from "../core/errors.ts";
import {
  hotCopyPath,
  hotCopyStagingPath,
  worktreeId as makeWorktreeId,
  sessionName,
  slugify,
  worktreePath,
} from "../core/paths.ts";
import type {
  Clock,
  ConfigPort,
  FilesPort,
  GitPort,
  Logger,
  Shell,
  StatePort,
  TmuxPort,
} from "../core/ports.ts";
import { validateBranch } from "../core/prs.ts";
import type { OnEvent, WorktreeService } from "../core/services.ts";
import type { Config, Repo, RepoId, State, Worktree } from "../core/types.ts";
import { mutateState } from "./stateMutation.ts";

export interface WorktreeServiceDependencies {
  state: StatePort;
  config: ConfigPort;
  git: GitPort;
  files: FilesPort;
  tmux: TmuxPort;
  shell: Shell;
  clock: Clock;
  logger: Logger;
  home?: string;
}

function toSwarmError(error: unknown, code: "fs" | "git" | "tmux", message: string): SwarmError {
  return error instanceof SwarmError ? error : new SwarmError(code, message, { cause: error });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDescendant(path: string, root: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`);
}

function assertWorktreePath(
  worktree: Worktree,
  repo: { owner: string; name: string },
  config: Config,
): void {
  const expected = worktreePath(config, repo.owner, repo.name, worktree.slug);
  if (
    resolve(worktree.path) !== resolve(expected) ||
    !isDescendant(expected, config.worktreesDir)
  ) {
    throw new SwarmError(
      "validation",
      `Refusing to delete worktree with an invalid path: ${worktree.path}`,
    );
  }
}

export function createWorktreeService({
  state,
  config,
  git,
  files,
  tmux,
  shell,
  clock,
  logger,
  home,
}: WorktreeServiceDependencies): WorktreeService {
  const preparations = new Map<RepoId, Promise<void>>();

  const loadState = async (): Promise<State> => {
    try {
      return await state.load();
    } catch (error) {
      throw toSwarmError(error, "fs", "Failed to load swarm state");
    }
  };

  const loadConfig = async (): Promise<Config> => {
    try {
      return await config.load();
    } catch (error) {
      throw toSwarmError(error, "fs", "Failed to load swarm configuration");
    }
  };

  const resolveRepo = (current: State, id: RepoId): Repo => {
    const repo = current.repos.find((candidate) => candidate.id === id);
    if (!repo) throw new SwarmError("not-found", `Repository not found: ${id}`);
    return repo;
  };

  const assertAvailable = (current: State, repo: Repo, slug: string): void => {
    const id = makeWorktreeId(repo.id, slug);
    if (current.worktrees.some((worktree) => worktree.id === id)) {
      throw new SwarmError("conflict", `Worktree already exists: ${id}`);
    }
    const session = sessionName(repo.name, slug);
    if (current.worktrees.some((worktree) => worktree.session === session)) {
      throw new SwarmError("conflict", `Tmux session name already exists: ${session}`);
    }
  };

  const assertDestinationAvailable = async (destination: string): Promise<void> => {
    try {
      if (await files.exists(destination)) {
        throw new SwarmError("conflict", `Worktree path already exists: ${destination}`);
      }
    } catch (error) {
      throw toSwarmError(error, "fs", `Failed to inspect worktree path: ${destination}`);
    }
  };

  const refreshRepository = async (
    repo: Repo,
    repoPath: string,
    onEvent?: OnEvent,
    persistDefaultBranch?: (branch: string) => Promise<void> | void,
  ): Promise<string> => {
    onEvent?.({ type: "step", label: "Fetching origin" });
    try {
      await git.fetch(repoPath, { prune: true });
    } catch (error) {
      throw toSwarmError(error, "git", `Failed to fetch repository: ${repo.id}`);
    }

    let defaultBranch: string;
    try {
      defaultBranch = await git.defaultBranch(repoPath, repo.defaultBranch);
      const remoteBranches = await git.remoteBranches(repoPath);
      if (!remoteBranches.includes(`origin/${defaultBranch}`)) {
        throw new SwarmError(
          "git",
          `Remote has no '${defaultBranch}' branch yet; push an initial commit to ${repo.id} first`,
        );
      }
    } catch (error) {
      throw toSwarmError(error, "git", `Failed to resolve repository base: ${repo.id}`);
    }

    if (defaultBranch !== repo.defaultBranch) {
      try {
        await persistDefaultBranch?.(defaultBranch);
        repo.defaultBranch = defaultBranch;
      } catch (error) {
        throw toSwarmError(error, "fs", `Failed to persist default branch for: ${repo.id}`);
      }
    }

    onEvent?.({ type: "step", label: "Updating base" });
    try {
      await git.resetToRemote(repoPath, defaultBranch);
    } catch (error) {
      throw toSwarmError(error, "git", `Failed to update repository base: ${repo.id}`);
    }
    return defaultBranch;
  };

  const preflightCreate = async (input: { repoId: RepoId; branch: string }): Promise<void> => {
    const current = await loadState();
    const repo = resolveRepo(current, input.repoId);
    const slug = slugify(input.branch);
    assertAvailable(current, repo, slug);
    const loadedConfig = await loadConfig();
    await assertDestinationAvailable(worktreePath(loadedConfig, repo.owner, repo.name, slug));
  };

  const service: WorktreeService = {
    async list(repoId) {
      const worktrees = (await loadState()).worktrees;
      return repoId === undefined
        ? worktrees
        : worktrees.filter((worktree) => worktree.repoId === repoId);
    },

    async remoteBranches(repoId) {
      const current = await loadState();
      const repo = current.repos.find((candidate) => candidate.id === repoId);
      if (!repo) throw new SwarmError("not-found", `Repository not found: ${repoId}`);
      try {
        const branches = await git.remoteBranches(repo.path);
        return branches.filter((branch) => branch !== "origin/HEAD" && branch !== "origin").sort();
      } catch (error) {
        throw toSwarmError(error, "git", `Failed to list remote branches for: ${repoId}`);
      }
    },

    prepareHotCopy(repoId, onEvent) {
      const existing = preparations.get(repoId);
      if (existing) return existing;

      const preparation = (async (): Promise<void> => {
        let staging: string | undefined;
        try {
          const loadedConfig = await loadConfig();
          const hot = hotCopyPath(loadedConfig.worktreesDir, repoId);
          staging = hotCopyStagingPath(loadedConfig.worktreesDir, repoId);

          try {
            if (await files.exists(hot)) {
              onEvent?.({ type: "done" });
              return;
            }
            if (await files.exists(staging)) {
              onEvent?.({ type: "step", label: "Removing stale prepared copy" });
              await files.removeTree(staging);
            }
          } catch (error) {
            throw toSwarmError(error, "fs", `Failed to inspect prepared copy for: ${repoId}`);
          }

          const current = await loadState();
          const repo = resolveRepo(current, repoId);
          await refreshRepository(repo, repo.path, onEvent, async (branch) => {
            await mutateState(state, (next) => {
              resolveRepo(next, repo.id).defaultBranch = branch;
            });
          });

          onEvent?.({ type: "step", label: "Copying repository" });
          try {
            await files.ensureDir(dirname(hot));
            await files.cloneTree(repo.path, staging);
          } catch (error) {
            throw toSwarmError(error, "fs", `Failed to prepare worktree copy for: ${repo.id}`);
          }

          onEvent?.({ type: "step", label: "Finalizing prepared copy" });
          try {
            await files.move(staging, hot);
          } catch (error) {
            throw toSwarmError(error, "fs", `Failed to finalize prepared copy for: ${repo.id}`);
          }
          onEvent?.({ type: "done" });
        } catch (error) {
          const failure =
            error instanceof SwarmError
              ? error
              : new SwarmError("fs", `Failed to prepare worktree copy for: ${repoId}`, {
                  cause: error,
                });
          if (staging) {
            await files.removeTree(staging).catch((cleanupError: unknown) => {
              logger.error(`Failed to clean up prepared copy staging for: ${repoId}`, cleanupError);
            });
          }
          onEvent?.({ type: "error", error: failure });
          throw failure;
        }
      })();
      preparations.set(repoId, preparation);
      void preparation.then(
        () => {
          if (preparations.get(repoId) === preparation) preparations.delete(repoId);
        },
        () => {
          if (preparations.get(repoId) === preparation) preparations.delete(repoId);
        },
      );
      return preparation;
    },

    async create(input, onEvent) {
      validateBranch(input.branch);
      if (
        input.source?.kind === "pull" &&
        (!Number.isInteger(input.source.number) || input.source.number <= 0)
      ) {
        throw new SwarmError("validation", `Invalid pull request number: ${input.source.number}`);
      }

      await preflightCreate(input);
      const pendingPreparation = preparations.get(input.repoId);
      if (pendingPreparation) {
        await pendingPreparation.catch((error: unknown) => {
          logger.warn(`Prepared copy failed; falling back for: ${input.repoId}`, error);
        });
      }

      let destination: string | undefined;
      let copyStarted = false;
      try {
        const created = await mutateState(state, async (next) => {
          const repo = resolveRepo(next, input.repoId);
          const slug = slugify(input.branch);
          const id = makeWorktreeId(repo.id, slug);
          assertAvailable(next, repo, slug);

          const loadedConfig = await loadConfig();
          destination = worktreePath(loadedConfig, repo.owner, repo.name, slug);
          await assertDestinationAvailable(destination);

          const hot = hotCopyPath(loadedConfig.worktreesDir, repo.id);
          let defaultBranch: string;
          let hasHotCopy: boolean;
          try {
            hasHotCopy = await files.exists(hot);
          } catch (error) {
            throw toSwarmError(error, "fs", `Failed to inspect prepared copy for: ${repo.id}`);
          }

          if (hasHotCopy) {
            onEvent?.({ type: "step", label: "Using prepared copy" });
            try {
              await files.move(hot, destination);
              copyStarted = true;
            } catch (error) {
              throw toSwarmError(error, "fs", `Failed to use prepared copy for: ${id}`);
            }
            defaultBranch = await refreshRepository(repo, destination, onEvent, (branch) => {
              repo.defaultBranch = branch;
            });
          } else {
            defaultBranch = await refreshRepository(repo, repo.path, onEvent, (branch) => {
              repo.defaultBranch = branch;
            });
            onEvent?.({ type: "step", label: "Copying repository" });
            try {
              await files.ensureDir(dirname(destination));
              copyStarted = true;
              await files.cloneTree(repo.path, destination);
            } catch (error) {
              throw toSwarmError(error, "fs", `Failed to copy worktree: ${id}`);
            }
          }

          let resolvedBaseRef: string;
          if (input.source?.kind === "pull") {
            resolvedBaseRef = `pull/${input.source.number}/head`;
            onEvent?.({ type: "step", label: "Fetching PR head" });
            try {
              await git.fetchPullHead(destination, input.source.number, input.branch);
              await git.checkoutTracking(destination, input.branch);
            } catch (error) {
              throw toSwarmError(error, "git", `Failed to fetch pull request head: ${id}`);
            }
          } else {
            onEvent?.({ type: "step", label: "Creating branch" });
            let branches: string[];
            try {
              branches = await git.remoteBranches(destination);
            } catch (error) {
              throw toSwarmError(error, "git", `Failed to inspect remote branches for: ${id}`);
            }
            const remoteBranch = `origin/${input.branch}`;
            resolvedBaseRef = branches.includes(remoteBranch)
              ? remoteBranch
              : (input.baseRef ?? `origin/${defaultBranch}`);
            try {
              if (branches.includes(remoteBranch)) {
                await git.checkoutTracking(destination, input.branch);
              } else {
                await git.checkoutNewBranch(destination, input.branch, resolvedBaseRef);
              }
            } catch (error) {
              throw toSwarmError(error, "git", `Failed to create worktree branch: ${input.branch}`);
            }
          }

          onEvent?.({ type: "step", label: "Running hooks" });
          for (const command of repo.hooks.postCreate) {
            try {
              const result = await shell.run("sh", ["-c", command], {
                cwd: destination,
                onStderrLine: (line) => onEvent?.({ type: "log", line }),
              });
              if (result.code !== 0) {
                const line = `Hook failed (${result.code}): ${command}`;
                onEvent?.({ type: "log", line });
                logger.warn(line, { stderr: result.stderr });
              }
            } catch (error) {
              const line = `Hook failed: ${command}: ${errorMessage(error)}`;
              onEvent?.({ type: "log", line });
              logger.warn(line, error);
            }
          }

          const worktree: Worktree = {
            id,
            repoId: repo.id,
            slug,
            branch: input.branch,
            baseRef: resolvedBaseRef,
            path: destination,
            session: sessionName(repo.name, slug),
            createdAt: clock.now().toISOString(),
          };
          next.worktrees.push(worktree);
          return worktree;
        });
        onEvent?.({ type: "done" });
        return created;
      } catch (error) {
        const failure =
          error instanceof SwarmError
            ? error
            : new SwarmError("git", "Failed to create worktree", { cause: error });
        if (copyStarted && destination) {
          try {
            await files.removeDetached(destination);
          } catch (cleanupError) {
            logger.error("Failed to clean up a partial worktree", cleanupError);
          }
        }
        onEvent?.({ type: "error", error: failure });
        throw failure;
      }
    },

    async delete(worktreeId, onEvent) {
      let moved: { source: string; trash: string } | undefined;
      try {
        const trashPath = await mutateState(state, async (next) => {
          const worktree = next.worktrees.find((candidate) => candidate.id === worktreeId);
          if (!worktree) {
            throw new SwarmError("not-found", `Worktree not found: ${worktreeId}`);
          }
          const repo = next.repos.find((candidate) => candidate.id === worktree.repoId);
          if (!repo)
            throw new SwarmError("validation", `Worktree has no registered repo: ${worktreeId}`);

          let loadedConfig: Config;
          try {
            loadedConfig = await config.load();
          } catch (error) {
            throw toSwarmError(error, "fs", "Failed to load swarm configuration");
          }
          assertWorktreePath(worktree, repo, loadedConfig);

          try {
            if (await tmux.hasSession(worktree.session)) {
              await tmux.killSession(worktree.session);
            }
          } catch (error) {
            throw toSwarmError(error, "tmux", `Failed to stop session: ${worktree.session}`);
          }

          const trashPath = join(
            home ?? dirname(loadedConfig.worktreesDir),
            "trash",
            `${clock.now().getTime()}-${worktree.slug}`,
          );
          try {
            await files.ensureDir(dirname(trashPath));
            await files.move(worktree.path, trashPath);
            moved = { source: worktree.path, trash: trashPath };
          } catch (error) {
            throw toSwarmError(error, "fs", `Failed to trash worktree: ${worktreeId}`);
          }

          next.worktrees = next.worktrees.filter((candidate) => candidate.id !== worktreeId);
          return trashPath;
        });
        moved = undefined;
        await files.removeDetached(trashPath).catch((error: unknown) => {
          logger.error(`Failed to remove trashed worktree: ${worktreeId}`, error);
        });
        onEvent?.({ type: "done" });
      } catch (error) {
        if (moved) {
          try {
            await files.move(moved.trash, moved.source);
          } catch (rollbackError) {
            logger.error(
              `Failed to restore worktree after state failure: ${worktreeId}`,
              rollbackError,
            );
          }
        }
        const failure =
          error instanceof SwarmError
            ? error
            : new SwarmError("fs", `Failed to delete worktree: ${worktreeId}`, { cause: error });
        onEvent?.({ type: "error", error: failure });
        throw failure;
      }
    },

    async touch(worktreeId) {
      await mutateState(state, (next) => {
        const index = next.worktrees.findIndex((worktree) => worktree.id === worktreeId);
        const current = next.worktrees[index];
        if (!current) throw new SwarmError("not-found", `Worktree not found: ${worktreeId}`);
        next.worktrees[index] = { ...current, lastOpenedAt: clock.now().toISOString() };
      });
    },
  };

  return service;
}
