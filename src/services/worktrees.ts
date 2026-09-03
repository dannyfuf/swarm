import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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
  interface Preparation {
    controller: AbortController;
    promise: Promise<void>;
  }

  const preparations = new Map<RepoId, Preparation>();
  const repoMutexes = new Map<RepoId, Promise<void>>();
  const deletingRepos = new Set<RepoId>();

  interface HotCopyMarker {
    fetchedAt: string;
    defaultBranch: string;
    sha: string;
    prepareFingerprint: string;
  }

  interface CreatingMarker {
    id: string;
    repoId: RepoId;
    branch: string;
    baseRef: string;
    createdAt: string;
  }

  interface SharedRefresh {
    mode: "skip" | "forced";
    controller: AbortController;
    interests: Set<symbol>;
    promise: Promise<void>;
  }

  interface RefreshQueue {
    active: SharedRefresh;
    forced?: SharedRefresh;
  }

  const refreshes = new Map<RepoId, RefreshQueue>();

  const throwIfAborted = (signal?: AbortSignal): void => {
    if (signal?.aborted) throw new SwarmError("cancelled", "Operation cancelled");
  };

  const assertRepoActive = (repoId: RepoId): void => {
    if (deletingRepos.has(repoId)) {
      throw new SwarmError("conflict", `Repository is being deleted: ${repoId}`);
    }
  };

  const withRepoMutex = async <T>(repoId: RepoId, fn: () => Promise<T>): Promise<T> => {
    const previous = repoMutexes.get(repoId) ?? Promise.resolve();
    let release = (): void => undefined;
    const held = new Promise<void>((resolveHeld) => {
      release = resolveHeld;
    });
    const tail = previous.catch(() => undefined).then(() => held);
    repoMutexes.set(repoId, tail);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (repoMutexes.get(repoId) === tail) repoMutexes.delete(repoId);
    }
  };

  const prepareFingerprint = (commands: string[]): string =>
    createHash("sha256").update(JSON.stringify(commands)).digest("hex");

  const remoteTrackingRef = (branch: string): string =>
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`;

  const remoteBranchFromRef = (ref: string | undefined): string | undefined => {
    if (!ref?.startsWith("origin/")) return undefined;
    const branch = ref.slice("origin/".length);
    validateBranch(branch);
    return branch;
  };

  const isFsCode = (error: unknown, codes: string[]): boolean => {
    let candidate: unknown = error;
    while (typeof candidate === "object" && candidate !== null) {
      if ("code" in candidate && codes.includes(String(candidate.code))) return true;
      candidate = "cause" in candidate ? candidate.cause : undefined;
    }
    return false;
  };

  const formatDuration = (durationMs: number): string =>
    durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1)}s`;

  const timed = async <T>(label: string, onEvent: OnEvent | undefined, fn: () => Promise<T>) => {
    onEvent?.({ type: "step", label });
    const startedAt = performance.now();
    try {
      return await fn();
    } finally {
      const durationMs = performance.now() - startedAt;
      const line = `${label} ${formatDuration(durationMs)}`;
      onEvent?.({ type: "log", line });
      logger.info(line, { durationMs });
    }
  };

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

  const assertCreateAvailable = (
    current: State,
    repo: Repo,
    slug: string,
    destination: string,
  ): void => {
    const id = makeWorktreeId(repo.id, slug);
    if (current.worktrees.some((worktree) => worktree.id === id)) {
      throw new SwarmError("conflict", `Worktree already exists: ${id}`);
    }
    const session = sessionName(repo.name, slug);
    if (current.worktrees.some((worktree) => worktree.session === session)) {
      throw new SwarmError("conflict", `Tmux session name already exists: ${session}`);
    }
    if (current.worktrees.some((worktree) => resolve(worktree.path) === resolve(destination))) {
      throw new SwarmError("conflict", `Worktree path already registered: ${destination}`);
    }
  };

  const trashUnregisteredPath = async (path: string, worktreesDir: string): Promise<void> => {
    const trashPath = join(
      home ?? dirname(worktreesDir),
      "trash",
      `${clock.now().getTime()}-${basename(path)}-${randomUUID()}`,
    );
    await files.ensureDir(dirname(trashPath));
    await files.move(path, trashPath);
    await files.removeDetached(trashPath).catch((error: unknown) => {
      logger.error(`Failed to remove reclaimed worktree path: ${path}`, error);
    });
  };

  const assertDestinationAvailable = async (
    destination: string,
    worktreesDir: string,
  ): Promise<void> => {
    try {
      if (await files.exists(destination)) {
        if ((await readCreatingMarkerText(destination)) !== null) {
          await trashUnregisteredPath(destination, worktreesDir);
          return;
        }
        throw new SwarmError("conflict", `Worktree path already exists: ${destination}`);
      }
    } catch (error) {
      throw toSwarmError(error, "fs", `Failed to inspect worktree path: ${destination}`);
    }
  };

  const resolveDefaultBranch = async (
    repo: Repo,
    repoPath: string,
    remoteBranches: string[],
    onEvent?: OnEvent,
    signal?: AbortSignal,
  ): Promise<string> => {
    try {
      const defaultBranch = await timed("Resolving default branch", onEvent, () =>
        git.defaultBranch(repoPath, repo.defaultBranch, signal, remoteBranches),
      );
      if (!remoteBranches.includes(`origin/${defaultBranch}`)) {
        throw new SwarmError(
          "git",
          `Remote has no '${defaultBranch}' branch yet; push an initial commit to ${repo.id} first`,
        );
      }
      return defaultBranch;
    } catch (error) {
      throw toSwarmError(error, "git", `Failed to resolve repository base: ${repo.id}`);
    }
  };

  const persistDefaultBranch = async (repoId: RepoId, branch: string): Promise<void> => {
    await mutateState(state, (next) => {
      resolveRepo(next, repoId).defaultBranch = branch;
    });
  };

  const refreshRepository = async (
    repo: Repo,
    repoPath: string,
    onEvent?: OnEvent,
    signal?: AbortSignal,
  ): Promise<{ defaultBranch: string; reset: boolean }> => {
    throwIfAborted(signal);
    try {
      await timed("Fetching origin", onEvent, () => git.fetch(repoPath, { prune: true, signal }));
    } catch (error) {
      throw toSwarmError(error, "git", `Failed to fetch repository: ${repo.id}`);
    }

    let remoteBranches: string[];
    try {
      remoteBranches = await timed("Listing remote branches", onEvent, () =>
        git.remoteBranches(repoPath, signal),
      );
    } catch (error) {
      throw toSwarmError(error, "git", `Failed to inspect remote branches for: ${repo.id}`);
    }
    const defaultBranch = await resolveDefaultBranch(
      repo,
      repoPath,
      remoteBranches,
      onEvent,
      signal,
    );

    if (defaultBranch !== repo.defaultBranch) {
      try {
        await persistDefaultBranch(repo.id, defaultBranch);
        repo.defaultBranch = defaultBranch;
      } catch (error) {
        throw toSwarmError(error, "fs", `Failed to persist default branch for: ${repo.id}`);
      }
    }

    let reset = false;
    try {
      const [headSha, remoteSha, dirty] = await timed("Checking repository state", onEvent, () =>
        Promise.all([
          git.revision(repoPath, "HEAD", signal),
          git.revision(repoPath, `origin/${defaultBranch}`, signal),
          git.isDirty(repoPath, { signal }),
        ]),
      );
      if (headSha !== remoteSha || dirty) {
        await timed("Updating base", onEvent, () =>
          git.resetToRemote(repoPath, defaultBranch, signal),
        );
        reset = true;
      }
    } catch (error) {
      throw toSwarmError(error, "git", `Failed to update repository base: ${repo.id}`);
    }
    return { defaultBranch, reset };
  };

  const hotMarkerPath = (repoPath: string): string => join(repoPath, ".git", "swarm-hot.json");
  const creatingMarkerPath = (repoPath: string): string =>
    join(repoPath, ".git", "swarm-creating.json");

  const parseHotMarker = (text: string | null): HotCopyMarker | null => {
    if (text === null) return null;
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
      const marker = value as Record<string, unknown>;
      if (
        typeof marker.fetchedAt !== "string" ||
        !Number.isFinite(Date.parse(marker.fetchedAt)) ||
        typeof marker.defaultBranch !== "string" ||
        typeof marker.sha !== "string" ||
        typeof marker.prepareFingerprint !== "string" ||
        !/^[0-9a-f]{64}$/iu.test(marker.prepareFingerprint) ||
        !/^[0-9a-f]{40,64}$/iu.test(marker.sha)
      ) {
        return null;
      }
      validateBranch(marker.defaultBranch);
      return {
        fetchedAt: marker.fetchedAt,
        defaultBranch: marker.defaultBranch,
        sha: marker.sha,
        prepareFingerprint: marker.prepareFingerprint,
      };
    } catch {
      return null;
    }
  };

  const readHotMarker = async (repoPath: string): Promise<HotCopyMarker | null> => {
    try {
      return parseHotMarker(await files.readText(hotMarkerPath(repoPath)));
    } catch (error) {
      logger.warn(`Failed to read prepared copy marker: ${repoPath}`, error);
      return null;
    }
  };

  const writeHotMarker = async (
    repoPath: string,
    defaultBranch: string,
    fingerprint: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    const marker: HotCopyMarker = {
      fetchedAt: clock.now().toISOString(),
      defaultBranch,
      sha: await git.revision(repoPath, `origin/${defaultBranch}`, signal),
      prepareFingerprint: fingerprint,
    };
    await files.writeTextAtomic(hotMarkerPath(repoPath), `${JSON.stringify(marker, null, 2)}\n`);
  };

  const parseCreatingMarker = (text: string | null): CreatingMarker | null => {
    if (text === null) return null;
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
      const marker = value as Record<string, unknown>;
      if (
        typeof marker.id !== "string" ||
        typeof marker.repoId !== "string" ||
        typeof marker.branch !== "string" ||
        typeof marker.baseRef !== "string" ||
        typeof marker.createdAt !== "string" ||
        !Number.isFinite(Date.parse(marker.createdAt))
      ) {
        return null;
      }
      validateBranch(marker.branch);
      return {
        id: marker.id,
        repoId: marker.repoId,
        branch: marker.branch,
        baseRef: marker.baseRef,
        createdAt: marker.createdAt,
      };
    } catch {
      return null;
    }
  };

  const readCreatingMarkerText = (repoPath: string): Promise<string | null> =>
    files.readText(creatingMarkerPath(repoPath));

  const writeCreatingMarker = (repoPath: string, marker: CreatingMarker): Promise<void> =>
    files.writeTextAtomic(creatingMarkerPath(repoPath), `${JSON.stringify(marker, null, 2)}\n`);

  const markerIsFresh = (
    marker: HotCopyMarker | null,
    freshnessMs: number,
    fingerprint: string,
  ): boolean => {
    if (marker === null) return false;
    if (marker.prepareFingerprint !== fingerprint) return false;
    const age = clock.now().getTime() - Date.parse(marker.fetchedAt);
    return age >= 0 && age < freshnessMs;
  };

  const runHooks = async (
    kind: "prepare",
    commands: string[],
    cwd: string,
    onEvent?: OnEvent,
    opts?: { signal?: AbortSignal },
  ): Promise<void> => {
    for (const [index, command] of commands.entries()) {
      throwIfAborted(opts?.signal);
      const label = `Running ${kind} hook ${index + 1}/${commands.length}`;
      await timed(label, onEvent, async () => {
        onEvent?.({ type: "log", line: `$ ${command}` });
        try {
          const code = (
            await shell.run("sh", ["-c", command], {
              cwd,
              signal: opts?.signal,
              onStderrLine: (line) => onEvent?.({ type: "log", line }),
            })
          ).code;
          if (code !== 0) {
            const line = `Hook failed (${code}): ${command}`;
            onEvent?.({ type: "log", line });
            logger.warn(line, { kind, cwd });
          }
        } catch (error) {
          if (opts?.signal?.aborted) throw error;
          const line = `Hook failed: ${command}: ${errorMessage(error)}`;
          onEvent?.({ type: "log", line });
          logger.warn(line, error);
        }
      });
    }
  };

  const runPostCreateHookSequence = async (
    commands: string[],
    cwd: string,
    logPath: string,
    onEvent?: OnEvent,
  ): Promise<void> => {
    if (commands.length === 0) return;
    const recordsPath = join(cwd, ".git", `swarm-post-create-${randomUUID()}.log`);
    const script = [
      'records="$1"',
      'log="$2"',
      'total="$3"',
      "shift 3",
      ': > "$records" || exit 125',
      "index=0",
      "for command do",
      "  index=$((index + 1))",
      "  started=$(date +%s)",
      '  printf "start\\t%s\\t%s\\n" "$index" "$started" >> "$records"',
      '  printf "[post-create hook %s/%s] start: %s\\n" "$index" "$total" "$command" >> "$log"',
      '  sh -c "$command" >> "$log" 2>&1',
      "  code=$?",
      "  ended=$(date +%s)",
      "  duration=$(((ended - started) * 1000))",
      '  printf "end\\t%s\\t%s\\t%s\\n" "$index" "$code" "$duration" >> "$records"',
      '  printf "[post-create hook %s/%s] end: exit=%s duration=%sms\\n" "$index" "$total" "$code" "$duration" >> "$log"',
      "done",
      "exit 0",
    ].join("\n");

    const runnerCode = await shell.runDetachedLogged(
      "sh",
      [
        "-c",
        script,
        "swarm-post-create",
        recordsPath,
        logPath,
        String(commands.length),
        ...commands,
      ],
      { cwd, logPath },
    );
    const records = await files.readText(recordsPath);
    await files.removeTree(recordsPath).catch((error: unknown) => {
      logger.warn(`Failed to remove post-create hook records: ${recordsPath}`, error);
    });

    const ends = new Map<number, { code: number; durationMs: number }>();
    for (const line of records?.split(/\r?\n/u) ?? []) {
      const match = /^end\t(\d+)\t(-?\d+)\t(\d+)$/u.exec(line);
      if (!match) continue;
      ends.set(Number(match[1]), { code: Number(match[2]), durationMs: Number(match[3]) });
    }
    for (const [index, command] of commands.entries()) {
      const label = `Running post-create hook ${index + 1}/${commands.length}`;
      onEvent?.({ type: "step", label });
      onEvent?.({ type: "log", line: `$ ${command}` });
      const record = ends.get(index + 1);
      if (!record) continue;
      const durationLine = `${label} ${formatDuration(record.durationMs)}`;
      onEvent?.({ type: "log", line: durationLine });
      logger.info(durationLine, { durationMs: record.durationMs });
      if (record.code !== 0) {
        const line = `Hook failed (${record.code}): ${command}`;
        onEvent?.({ type: "log", line });
        logger.warn(line, { kind: "post-create", cwd });
      }
    }
    if (runnerCode !== 0) {
      const line = `Post-create hook runner failed (${runnerCode})`;
      onEvent?.({ type: "log", line });
      logger.warn(line, { cwd });
    }
  };

  const refreshForCreate = async (
    repo: Repo,
    repoPath: string,
    requestedBranch: string | undefined,
    requestedBaseRef: string | undefined,
    freshnessMs: number,
    onEvent?: OnEvent,
    signal?: AbortSignal,
  ): Promise<{
    defaultBranch: string;
    remoteBranches: string[];
    marker: HotCopyMarker | null;
    reset: boolean;
  }> => {
    throwIfAborted(signal);
    const marker = await timed("Reading freshness marker", onEvent, () => readHotMarker(repoPath));
    let remoteBranches: string[];
    try {
      remoteBranches = await timed("Listing remote branches", onEvent, () =>
        git.remoteBranches(repoPath, signal),
      );
    } catch (error) {
      throw toSwarmError(error, "git", `Failed to inspect remote branches for: ${repo.id}`);
    }

    const fingerprint = prepareFingerprint(repo.hooks.prepare);
    const markerIsYoung = markerIsFresh(marker, freshnessMs, fingerprint);
    const markerHasRemote =
      marker !== null && markerIsYoung && remoteBranches.includes(`origin/${marker.defaultBranch}`);
    const defaultBranch = markerHasRemote
      ? marker.defaultBranch
      : await timed("Resolving default branch", onEvent, () =>
          git.defaultBranch(repoPath, repo.defaultBranch, signal, remoteBranches),
        );

    let markerMatchesRemote = false;
    let remoteSha: string | undefined;
    if (markerHasRemote) {
      try {
        remoteSha = await timed("Checking freshness marker", onEvent, () =>
          git.revision(repoPath, `origin/${defaultBranch}`, signal),
        );
        markerMatchesRemote = remoteSha === marker.sha;
      } catch (error) {
        if (signal?.aborted) throw error;
        logger.warn(`Prepared copy marker could not be verified: ${repo.id}`, error);
      }
    }

    const requestedBaseBranch = remoteBranchFromRef(requestedBaseRef);
    let requestedBranchFetchFailed = false;
    if (requestedBranch !== undefined) {
      const mandatoryBranches = [...new Set([defaultBranch, requestedBaseBranch])].filter(
        (branch): branch is string => branch !== undefined,
      );
      const refs = [...new Set([...mandatoryBranches, requestedBranch])].map(remoteTrackingRef);
      try {
        await timed("Fetching origin", onEvent, () =>
          git.fetchRefs(repoPath, "origin", refs, signal),
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        requestedBranchFetchFailed = !mandatoryBranches.includes(requestedBranch);
        logger.info(
          requestedBranchFetchFailed
            ? `Requested branch is not available remotely; fetching base only: ${repo.id}`
            : `Default branch fetch failed; retrying: ${repo.id}`,
          { branch: requestedBranch, error: errorMessage(error) },
        );
        try {
          await timed("Fetching required base", onEvent, () =>
            git.fetchRefs(repoPath, "origin", mandatoryBranches.map(remoteTrackingRef), signal),
          );
        } catch (fallbackError) {
          if (requestedBaseBranch !== undefined && requestedBaseBranch !== defaultBranch) {
            throw new SwarmError(
              "git",
              `Failed to fetch base ref '${requestedBaseRef}' for ${repo.id}`,
              { cause: fallbackError },
            );
          }
          throw toSwarmError(fallbackError, "git", `Failed to fetch repository: ${repo.id}`);
        }
      }
      remoteSha = undefined;
    } else if (!markerMatchesRemote) {
      try {
        await timed("Fetching origin", onEvent, () =>
          git.fetchRefs(repoPath, "origin", [remoteTrackingRef(defaultBranch)], signal),
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        logger.warn(`Narrow fetch failed; retrying full fetch for: ${repo.id}`, error);
        try {
          await timed("Fetching full origin", onEvent, () =>
            git.fetch(repoPath, { prune: true, signal }),
          );
        } catch (fallbackError) {
          throw toSwarmError(fallbackError, "git", `Failed to fetch repository: ${repo.id}`);
        }
      }
      remoteSha = undefined;
    }

    if (requestedBranch !== undefined || !markerMatchesRemote) {
      try {
        remoteBranches = await timed("Relisting remote branches", onEvent, () =>
          git.remoteBranches(repoPath, signal),
        );
      } catch (error) {
        throw toSwarmError(error, "git", `Failed to inspect remote branches for: ${repo.id}`);
      }
      if (requestedBranchFetchFailed) {
        remoteBranches = remoteBranches.filter((branch) => branch !== `origin/${requestedBranch}`);
      }
      if (
        requestedBaseRef !== undefined &&
        requestedBaseBranch !== undefined &&
        !remoteBranches.includes(requestedBaseRef)
      ) {
        throw new SwarmError(
          "git",
          `Failed to fetch base ref '${requestedBaseRef}' for ${repo.id}`,
        );
      }
    }

    let headSha: string;
    let dirty: boolean;
    try {
      [headSha, remoteSha, dirty] = await timed("Checking repository state", onEvent, () =>
        Promise.all([
          git.revision(repoPath, "HEAD", signal),
          remoteSha === undefined
            ? git.revision(repoPath, `origin/${defaultBranch}`, signal)
            : Promise.resolve(remoteSha),
          git.isDirty(repoPath, { signal }),
        ]),
      );
    } catch (error) {
      if (!remoteBranches.includes(`origin/${defaultBranch}`)) {
        throw new SwarmError(
          "git",
          `Remote has no '${defaultBranch}' branch yet; push an initial commit to ${repo.id} first`,
          { cause: error },
        );
      }
      throw toSwarmError(error, "git", `Failed to inspect repository state: ${repo.id}`);
    }

    const reset = headSha !== remoteSha || dirty;
    if (reset) {
      try {
        await timed("Updating base", onEvent, () =>
          git.resetToRemote(repoPath, defaultBranch, signal),
        );
      } catch (error) {
        throw toSwarmError(error, "git", `Failed to update repository base: ${repo.id}`);
      }
    }

    return { defaultBranch, remoteBranches, marker, reset };
  };

  const preflightCreate = async (
    input: { repoId: RepoId; branch: string },
    onEvent?: OnEvent,
  ): Promise<{
    repo: Repo;
    loadedConfig: Config;
    slug: string;
    id: string;
    destination: string;
  }> => {
    return timed("Checking prerequisites", onEvent, async () => {
      const [current, loadedConfig] = await Promise.all([loadState(), loadConfig()]);
      const repo = resolveRepo(current, input.repoId);
      const slug = slugify(input.branch);
      const id = makeWorktreeId(repo.id, slug);
      const destination = worktreePath(loadedConfig, repo.owner, repo.name, slug);
      assertCreateAvailable(current, repo, slug, destination);
      await assertDestinationAvailable(destination, loadedConfig.worktreesDir);
      return { repo, loadedConfig, slug, id, destination };
    });
  };

  const hotSlotEntry = (name: string): { slot: number; staging: boolean } | undefined => {
    const match = /^\.hot(?:\.(\d+))?(\.staging)?$/u.exec(name);
    if (!match) return undefined;
    return { slot: match[1] === undefined ? 0 : Number(match[1]), staging: match[2] !== undefined };
  };

  const listHotSlotEntries = async (
    worktreesDir: string,
    repoId: RepoId,
  ): Promise<Array<{ name: string; path: string; slot: number; staging: boolean }>> => {
    const root = join(worktreesDir, repoId);
    if (!(await files.exists(root))) return [];
    const names = await files.listDirs(root, { includeReserved: true });
    return names.flatMap((name) => {
      const parsed = hotSlotEntry(name);
      return parsed ? [{ name, path: join(root, name), ...parsed }] : [];
    });
  };

  const cleanExcessHotSlots = async (
    loadedConfig: Config,
    repoId: RepoId,
    signal?: AbortSignal,
  ): Promise<void> => {
    const entries = await listHotSlotEntries(loadedConfig.worktreesDir, repoId);
    for (const entry of entries) {
      throwIfAborted(signal);
      if (entry.slot >= loadedConfig.hotPoolSize) await files.removeTree(entry.path);
    }
  };

  const executeRefresh = async (
    repoId: RepoId,
    skipIfFresh: boolean,
    signal: AbortSignal,
  ): Promise<void> => {
    assertRepoActive(repoId);
    throwIfAborted(signal);
    const pendingPreparation = preparations.get(repoId);
    if (pendingPreparation) await pendingPreparation.promise;
    assertRepoActive(repoId);
    throwIfAborted(signal);

    const [loadedConfig, current] = await Promise.all([loadConfig(), loadState()]);
    const repo = resolveRepo(current, repoId);
    const fingerprint = prepareFingerprint(repo.hooks.prepare);
    const hotCopies: Array<{ path: string; slot: number }> = [];
    try {
      await timed("Inspecting prepared copy pool", undefined, async () => {
        for (let slot = 0; slot < loadedConfig.hotPoolSize; slot += 1) {
          throwIfAborted(signal);
          const hot = hotCopyPath(loadedConfig.worktreesDir, repoId, slot);
          if (await files.exists(hot)) hotCopies.push({ path: hot, slot });
        }
      });
    } catch (error) {
      throw toSwarmError(error, "fs", `Failed to inspect prepared copy pool for: ${repoId}`);
    }

    if (skipIfFresh && hotCopies.length > 0) {
      const markers = await Promise.all(hotCopies.map((hot) => readHotMarker(hot.path)));
      if (
        markers.every((marker) => markerIsFresh(marker, loadedConfig.hotFreshnessMs, fingerprint))
      ) {
        return;
      }
    }

    if (hotCopies.length === 0) {
      await withRepoMutex(repoId, async () => {
        throwIfAborted(signal);
        await refreshRepository(repo, repo.path, undefined, signal);
      });
      return;
    }

    for (const { path: hot, slot } of hotCopies) {
      throwIfAborted(signal);
      await withRepoMutex(repoId, async () => {
        throwIfAborted(signal);
        assertRepoActive(repoId);
        if (!(await files.exists(hot))) return;
        const oldMarker = await readHotMarker(hot);
        if (oldMarker !== null && oldMarker.prepareFingerprint !== fingerprint) {
          const staging = hotCopyStagingPath(loadedConfig.worktreesDir, repoId, slot);
          try {
            await files.removeTree(hot);
            await files.removeTree(staging);
            const { defaultBranch } = await refreshRepository(repo, repo.path, undefined, signal);
            throwIfAborted(signal);
            await files.ensureDir(dirname(staging));
            await files.cloneTree(repo.path, staging);
            await runHooks("prepare", repo.hooks.prepare, staging, undefined, { signal });
            throwIfAborted(signal);
            await writeHotMarker(staging, defaultBranch, fingerprint, signal);
            assertRepoActive(repoId);
            resolveRepo(await loadState(), repoId);
            await files.move(staging, hot);
          } catch (error) {
            await files.removeTree(staging).catch((cleanupError: unknown) => {
              logger.error(`Failed to clean rebuilt prepared copy for: ${repoId}`, cleanupError);
            });
            throw error;
          }
          return;
        }

        await files.removeTree(hotMarkerPath(hot));
        const { defaultBranch, reset } = await refreshRepository(repo, hot, undefined, signal);
        if (reset) await runHooks("prepare", repo.hooks.prepare, hot, undefined, { signal });
        throwIfAborted(signal);
        try {
          await timed("Writing freshness marker", undefined, () =>
            writeHotMarker(hot, defaultBranch, fingerprint, signal),
          );
        } catch (error) {
          throw toSwarmError(error, "fs", `Failed to update prepared copy marker: ${repoId}`);
        }
      });
    }
  };

  const createSharedRefresh = (
    repoId: RepoId,
    mode: SharedRefresh["mode"],
    after?: Promise<void>,
  ): SharedRefresh => {
    const controller = new AbortController();
    const run = {} as SharedRefresh;
    run.mode = mode;
    run.controller = controller;
    run.interests = new Set();
    run.promise = (async () => {
      if (after) await after.catch(() => undefined);
      throwIfAborted(controller.signal);
      await executeRefresh(repoId, mode === "skip", controller.signal);
    })();
    return run;
  };

  const subscribeRefresh = (run: SharedRefresh, signal?: AbortSignal): Promise<void> => {
    const interest = Symbol("refresh-caller");
    run.interests.add(interest);
    let detached = false;
    const detach = (): void => {
      if (detached) return;
      detached = true;
      run.interests.delete(interest);
    };
    if (!signal) return run.promise.finally(detach);
    if (signal.aborted) {
      detach();
      if (run.interests.size === 0) run.controller.abort();
      return Promise.reject(new SwarmError("cancelled", "Operation cancelled"));
    }
    return new Promise<void>((resolvePromise, rejectPromise) => {
      const abort = (): void => {
        detach();
        if (run.interests.size === 0) run.controller.abort();
        rejectPromise(new SwarmError("cancelled", "Operation cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      void run.promise.then(
        () => {
          signal.removeEventListener("abort", abort);
          detach();
          resolvePromise();
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          detach();
          rejectPromise(error);
        },
      );
    });
  };

  const requestRefresh = (
    repoId: RepoId,
    opts?: { signal?: AbortSignal; skipIfFresh?: boolean },
  ): Promise<void> => {
    assertRepoActive(repoId);
    const mode: SharedRefresh["mode"] = opts?.skipIfFresh ? "skip" : "forced";
    let queue = refreshes.get(repoId);
    let run: SharedRefresh;
    if (!queue) {
      run = createSharedRefresh(repoId, mode);
      queue = { active: run };
      refreshes.set(repoId, queue);
    } else if (queue.active.mode === "forced" || mode === "skip") {
      run = queue.active;
    } else {
      run = queue.forced ?? createSharedRefresh(repoId, "forced", queue.active.promise);
      queue.forced = run;
    }

    const trackedQueue = queue;
    void run.promise.then(
      () => {
        if (refreshes.get(repoId) !== trackedQueue) return;
        if (trackedQueue.active === run && trackedQueue.forced) {
          trackedQueue.active = trackedQueue.forced;
          trackedQueue.forced = undefined;
        } else if (trackedQueue.active === run || trackedQueue.forced === run) {
          refreshes.delete(repoId);
        }
      },
      () => {
        if (refreshes.get(repoId) !== trackedQueue) return;
        if (trackedQueue.active === run && trackedQueue.forced) {
          trackedQueue.active = trackedQueue.forced;
          trackedQueue.forced = undefined;
        } else if (trackedQueue.active === run || trackedQueue.forced === run) {
          refreshes.delete(repoId);
        }
      },
    );
    return subscribeRefresh(run, opts?.signal);
  };

  const service: WorktreeService = {
    async reconcileCreating() {
      const [current, loadedConfig] = await Promise.all([loadState(), loadConfig()]);
      for (const repo of current.repos) {
        const root = join(loadedConfig.worktreesDir, repo.id);
        if (!(await files.exists(root))) continue;
        for (const name of await files.listDirs(root, { includeReserved: true })) {
          const candidatePath = join(root, name);
          const markerText = await readCreatingMarkerText(candidatePath);
          if (markerText === null) continue;

          const alreadyRegistered = (await loadState()).worktrees.some(
            (worktree) => resolve(worktree.path) === resolve(candidatePath),
          );
          if (alreadyRegistered) {
            await files.removeTree(creatingMarkerPath(candidatePath));
            continue;
          }

          const marker = parseCreatingMarker(markerText);
          const expectedId = makeWorktreeId(repo.id, name);
          let branchMatches = false;
          if (
            marker !== null &&
            marker.repoId === repo.id &&
            marker.id === expectedId &&
            marker.baseRef.length > 0 &&
            resolve(candidatePath) ===
              resolve(worktreePath(loadedConfig, repo.owner, repo.name, name))
          ) {
            branchMatches = await git
              .currentBranch(candidatePath)
              .then((branch) => branch === marker.branch)
              .catch(() => false);
          }

          if (marker !== null && branchMatches) {
            try {
              await mutateState(state, (next) => {
                const registeredRepo = resolveRepo(next, repo.id);
                if (next.worktrees.some((worktree) => worktree.id === marker.id)) return;
                assertCreateAvailable(next, registeredRepo, name, candidatePath);
                next.worktrees.push({
                  id: marker.id,
                  repoId: repo.id,
                  slug: name,
                  branch: marker.branch,
                  baseRef: marker.baseRef,
                  path: candidatePath,
                  session: sessionName(repo.name, name),
                  createdAt: marker.createdAt,
                });
              });
              await files.removeTree(creatingMarkerPath(candidatePath));
              continue;
            } catch (error) {
              logger.warn(`Failed to register interrupted worktree: ${marker.id}`, error);
              if (!(error instanceof SwarmError) || error.code === "fs") throw error;
            }
          }

          await trashUnregisteredPath(candidatePath, loadedConfig.worktreesDir);
        }
      }
    },

    async coordinateRepoDeletion(repoId, action) {
      if (deletingRepos.has(repoId)) {
        throw new SwarmError("conflict", `Repository is already being deleted: ${repoId}`);
      }
      deletingRepos.add(repoId);
      try {
        const preparation = preparations.get(repoId);
        preparation?.controller.abort();
        const refresh = refreshes.get(repoId);
        refresh?.active.controller.abort();
        refresh?.forced?.controller.abort();
        await Promise.allSettled([
          ...(preparation ? [preparation.promise] : []),
          ...(refresh ? [refresh.active.promise] : []),
          ...(refresh?.forced ? [refresh.forced.promise] : []),
        ]);
        await withRepoMutex(repoId, async () => {
          const loadedConfig = await loadConfig();
          const entries = await listHotSlotEntries(loadedConfig.worktreesDir, repoId);
          for (const entry of entries) await files.removeTree(entry.path);
          await action();
        });
      } finally {
        deletingRepos.delete(repoId);
      }
    },

    async list(repoId) {
      const worktrees = (await loadState()).worktrees;
      return repoId === undefined
        ? worktrees
        : worktrees.filter((worktree) => worktree.repoId === repoId);
    },

    async remoteBranches(repoId) {
      const [current, loadedConfig] = await Promise.all([loadState(), loadConfig()]);
      const repo = current.repos.find((candidate) => candidate.id === repoId);
      if (!repo) throw new SwarmError("not-found", `Repository not found: ${repoId}`);
      try {
        let target = repo.path;
        for (let slot = 0; slot < loadedConfig.hotPoolSize; slot += 1) {
          const candidate = hotCopyPath(loadedConfig.worktreesDir, repoId, slot);
          if (await files.exists(candidate)) {
            target = candidate;
            break;
          }
        }
        const branches = await git.remoteBranches(target);
        return branches.filter((branch) => branch !== "origin/HEAD" && branch !== "origin").sort();
      } catch (error) {
        throw toSwarmError(error, "git", `Failed to list remote branches for: ${repoId}`);
      }
    },

    prepareHotCopy(repoId, onEvent, opts) {
      assertRepoActive(repoId);
      const existing = preparations.get(repoId);
      if (existing) return existing.promise;

      const controller = new AbortController();
      const signal = opts?.signal
        ? AbortSignal.any([controller.signal, opts.signal])
        : controller.signal;

      const promise = (async (): Promise<void> => {
        let staging: string | undefined;
        try {
          const loadedConfig = await loadConfig();
          assertRepoActive(repoId);
          throwIfAborted(signal);
          await withRepoMutex(repoId, async () => {
            assertRepoActive(repoId);
            throwIfAborted(signal);
            await cleanExcessHotSlots(loadedConfig, repoId, signal);
            if (loadedConfig.hotPoolSize === 0) return;

            let missingSlot: number | undefined;
            try {
              await timed("Inspecting prepared copy pool", onEvent, async () => {
                for (let slot = 0; slot < loadedConfig.hotPoolSize; slot += 1) {
                  throwIfAborted(signal);
                  const hot = hotCopyPath(loadedConfig.worktreesDir, repoId, slot);
                  const slotStaging = hotCopyStagingPath(loadedConfig.worktreesDir, repoId, slot);
                  const [hasHotCopy, hasStagingCopy] = await Promise.all([
                    files.exists(hot),
                    files.exists(slotStaging),
                  ]);
                  if (hasStagingCopy) await files.removeTree(slotStaging);
                  if (hasHotCopy) continue;
                  missingSlot = slot;
                  return;
                }
              });
            } catch (error) {
              throw toSwarmError(
                error,
                "fs",
                `Failed to inspect prepared copy pool for: ${repoId}`,
              );
            }
            if (missingSlot === undefined) return;

            const current = await loadState();
            const repo = resolveRepo(current, repoId);
            const { defaultBranch } = await refreshRepository(repo, repo.path, onEvent, signal);
            throwIfAborted(signal);

            const hot = hotCopyPath(loadedConfig.worktreesDir, repoId, missingSlot);
            staging = hotCopyStagingPath(loadedConfig.worktreesDir, repoId, missingSlot);
            try {
              await timed(`Copying repository for slot ${missingSlot}`, onEvent, async () => {
                throwIfAborted(signal);
                await files.ensureDir(dirname(hot));
                await files.cloneTree(repo.path, staging as string);
              });
              await runHooks("prepare", repo.hooks.prepare, staging, onEvent, {
                signal,
              });
              throwIfAborted(signal);
              await timed(`Writing freshness marker for slot ${missingSlot}`, onEvent, () =>
                writeHotMarker(
                  staging as string,
                  defaultBranch,
                  prepareFingerprint(repo.hooks.prepare),
                  signal,
                ),
              );
              throwIfAborted(signal);
              assertRepoActive(repoId);
              resolveRepo(await loadState(), repoId);
              await timed(`Finalizing prepared copy slot ${missingSlot}`, onEvent, () =>
                files.move(staging as string, hot),
              );
              staging = undefined;
            } catch (error) {
              throw toSwarmError(error, "fs", `Failed to prepare worktree copy for: ${repo.id}`);
            }
          });
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
      const preparation: Preparation = { controller, promise };
      preparations.set(repoId, preparation);
      void promise.then(
        () => {
          if (preparations.get(repoId) === preparation) preparations.delete(repoId);
        },
        () => {
          if (preparations.get(repoId) === preparation) preparations.delete(repoId);
        },
      );
      return promise;
    },

    refreshPreparedCopy(repoId, opts) {
      return requestRefresh(repoId, opts);
    },

    async awaitPendingRefresh(repoId) {
      const queue = refreshes.get(repoId);
      if (!queue) return;
      await (queue.forced?.promise ?? queue.active.promise);
    },

    async create(input, onEvent) {
      validateBranch(input.branch);
      assertRepoActive(input.repoId);
      if (
        input.source?.kind === "pull" &&
        (!Number.isInteger(input.source.number) || input.source.number <= 0)
      ) {
        throw new SwarmError("validation", `Invalid pull request number: ${input.source.number}`);
      }

      const preflight = await preflightCreate(input, onEvent);
      const pendingRefresh = refreshes.get(input.repoId);
      if (pendingRefresh) {
        await timed(
          "Waiting for prepared copy refresh",
          onEvent,
          () => pendingRefresh.forced?.promise ?? pendingRefresh.active.promise,
        );
      }
      const pendingPreparation = preparations.get(input.repoId);
      if (pendingPreparation) {
        await timed("Waiting for prepared copy", onEvent, () => pendingPreparation.promise).catch(
          (error: unknown) => {
            logger.warn(`Prepared copy failed; falling back for: ${input.repoId}`, error);
          },
        );
      }

      const { repo, loadedConfig, slug, id, destination } = preflight;
      assertRepoActive(repo.id);
      const attemptPath = `${destination}.creating-${randomUUID()}`;
      let attemptExists = false;
      let published = false;
      try {
        let claimedHotCopy: string | undefined;
        try {
          await withRepoMutex(repo.id, async () => {
            await timed("Claiming prepared copy", onEvent, async () => {
              for (let slot = 0; slot < loadedConfig.hotPoolSize; slot += 1) {
                const candidate = hotCopyPath(loadedConfig.worktreesDir, repo.id, slot);
                try {
                  await files.move(candidate, attemptPath);
                  claimedHotCopy = candidate;
                  attemptExists = true;
                  onEvent?.({ type: "prepared-copy-claimed", repoId: repo.id });
                  return;
                } catch (error) {
                  if (isFsCode(error, ["ENOENT"])) continue;
                  throw error;
                }
              }
              await files.ensureDir(dirname(attemptPath));
              attemptExists = true;
              await files.cloneTree(repo.path, attemptPath);
            });
          });
        } catch (error) {
          throw toSwarmError(error, "fs", `Failed to claim or copy worktree: ${id}`);
        }

        const { defaultBranch, remoteBranches, marker, reset } = await refreshForCreate(
          repo,
          attemptPath,
          input.source?.kind === "pull" ? undefined : input.branch,
          input.source?.kind === "pull" ? undefined : input.baseRef,
          loadedConfig.hotFreshnessMs,
          onEvent,
        );

        let resolvedBaseRef: string;
        if (input.source?.kind === "pull") {
          const pullNumber = input.source.number;
          resolvedBaseRef = `pull/${pullNumber}/head`;
          try {
            await timed("Fetching PR head", onEvent, async () => {
              await git.fetchPullHead(attemptPath, pullNumber, input.branch);
              await git.checkoutTracking(attemptPath, input.branch);
            });
          } catch (error) {
            throw toSwarmError(error, "git", `Failed to fetch pull request head: ${id}`);
          }
        } else {
          const remoteBranch = `origin/${input.branch}`;
          resolvedBaseRef = remoteBranches.includes(remoteBranch)
            ? remoteBranch
            : (input.baseRef ?? `origin/${defaultBranch}`);
          try {
            await timed("Creating branch", onEvent, async () => {
              if (remoteBranches.includes(remoteBranch)) {
                await git.checkoutTracking(attemptPath, input.branch);
              } else {
                await git.checkoutNewBranch(attemptPath, input.branch, resolvedBaseRef);
              }
            });
          } catch (error) {
            throw toSwarmError(error, "git", `Failed to create worktree branch: ${input.branch}`);
          }
        }

        if (
          claimedHotCopy === undefined ||
          reset ||
          marker?.prepareFingerprint !== prepareFingerprint(repo.hooks.prepare)
        ) {
          await runHooks("prepare", repo.hooks.prepare, attemptPath, onEvent);
        }

        const createdAt = clock.now().toISOString();
        const creatingMarker: CreatingMarker = {
          id,
          repoId: repo.id,
          branch: input.branch,
          baseRef: resolvedBaseRef,
          createdAt,
        };
        const created = await timed("Registering worktree", onEvent, () =>
          mutateState(state, async (next) => {
            const registeredRepo = resolveRepo(next, input.repoId);
            assertCreateAvailable(next, registeredRepo, slug, destination);
            await assertDestinationAvailable(destination, loadedConfig.worktreesDir);
            try {
              await writeCreatingMarker(attemptPath, creatingMarker);
              await files.move(attemptPath, destination);
              attemptExists = false;
              published = true;
            } catch (error) {
              if (isFsCode(error, ["EEXIST", "ENOTEMPTY"])) {
                throw new SwarmError("conflict", `Worktree path already exists: ${destination}`, {
                  cause: error,
                });
              }
              throw toSwarmError(error, "fs", `Failed to publish worktree: ${id}`);
            }
            const worktree: Worktree = {
              id,
              repoId: registeredRepo.id,
              slug,
              branch: input.branch,
              baseRef: resolvedBaseRef,
              path: destination,
              session: sessionName(registeredRepo.name, slug),
              createdAt,
            };
            registeredRepo.defaultBranch = defaultBranch;
            next.worktrees.push(worktree);
            return worktree;
          }),
        );
        await files.removeTree(creatingMarkerPath(destination)).catch((error: unknown) => {
          logger.warn(`Failed to remove worktree creation marker: ${id}`, error);
        });
        onEvent?.({ type: "done" });
        return created;
      } catch (error) {
        const failure =
          error instanceof SwarmError
            ? error
            : new SwarmError("git", "Failed to create worktree", { cause: error });
        if (published) {
          const trashPath = join(
            home ?? dirname(loadedConfig.worktreesDir),
            "trash",
            `${clock.now().getTime()}-${slug}`,
          );
          try {
            await files.ensureDir(dirname(trashPath));
            await files.move(destination, trashPath);
            published = false;
            await files.removeDetached(trashPath).catch((cleanupError: unknown) => {
              logger.error("Failed to remove trashed unregistered worktree", cleanupError);
            });
          } catch (cleanupError) {
            logger.error("Failed to trash an unregistered worktree", cleanupError);
          }
        }
        if (attemptExists && failure.code === "conflict") {
          const trashPath = join(
            home ?? dirname(loadedConfig.worktreesDir),
            "trash",
            `${clock.now().getTime()}-${slug}-${randomUUID()}`,
          );
          try {
            await files.ensureDir(dirname(trashPath));
            await files.move(attemptPath, trashPath);
            attemptExists = false;
            await files.removeDetached(trashPath).catch((cleanupError: unknown) => {
              logger.error("Failed to remove trashed unregistered worktree", cleanupError);
            });
          } catch (cleanupError) {
            logger.error("Failed to trash an unregistered worktree attempt", cleanupError);
          }
        }
        if (attemptExists) {
          try {
            await files.removeDetached(attemptPath);
          } catch (cleanupError) {
            logger.error("Failed to clean up a partial worktree", cleanupError);
          }
        }
        onEvent?.({ type: "error", error: failure });
        throw failure;
      }
    },

    async runPostCreateHooks(worktreeId, onEvent) {
      try {
        const current = await loadState();
        const worktree = current.worktrees.find((candidate) => candidate.id === worktreeId);
        if (!worktree) {
          throw new SwarmError("not-found", `Worktree not found: ${worktreeId}`);
        }
        const repo = resolveRepo(current, worktree.repoId);
        const loadedConfig = await loadConfig();
        await runPostCreateHookSequence(
          repo.hooks.postCreate,
          worktree.path,
          join(home ?? dirname(loadedConfig.worktreesDir), "logs", "swarm.log"),
          onEvent,
        );
        onEvent?.({ type: "done" });
      } catch (error) {
        const failure =
          error instanceof SwarmError
            ? error
            : new SwarmError("fs", `Failed to run post-create hooks for: ${worktreeId}`, {
                cause: error,
              });
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
