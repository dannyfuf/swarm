import type { SwarmError } from "./errors.ts";
import type {
  CloneJob,
  Context,
  ContextId,
  HostId,
  PrRepoSlice,
  PrTab,
  PullRequest,
  RemoteRepo,
  Repo,
  RepoId,
  Worktree,
  WorktreeId,
  WorktreeInspection,
  WorktreeStatus,
} from "./types.ts";

export type OpEvent =
  | { type: "step"; label: string }
  | { type: "log"; line: string }
  | { type: "prepared-copy-claimed"; repoId: RepoId }
  | { type: "done" }
  | { type: "error"; error: SwarmError };

export type OnEvent = (event: OpEvent) => void;

export interface ContextService {
  list(): Promise<Context[]>;
  create(input: { name: string; owners: string[] }): Promise<Context>;
  update(id: ContextId, patch: Partial<Pick<Context, "name" | "owners">>): Promise<Context>;
  delete(id: ContextId, onEvent?: OnEvent): Promise<void>;
  setActive(id: ContextId): Promise<void>;
}

export interface RepoService {
  list(contextId?: ContextId): Promise<Repo[]>;
  searchRemote(
    contextId: ContextId,
    query: string,
    opts?: { refresh?: boolean; signal?: AbortSignal },
  ): Promise<RemoteRepo[]>;
  clone(
    remote: RemoteRepo,
    contextId: ContextId,
    onEvent?: OnEvent,
    opts?: { url?: string },
  ): Promise<CloneJob>;
  reconcileClones(): Promise<CloneJob[]>;
  assign(repoId: RepoId, contextId: ContextId): Promise<Repo>;
  delete(repoId: RepoId, onEvent?: OnEvent): Promise<void>;
}

export interface WorktreeService {
  reconcileCreating(): Promise<void>;
  coordinateRepoDeletion(repoId: RepoId, action: () => Promise<void>): Promise<void>;
  list(repoId?: RepoId): Promise<Worktree[]>;
  remoteBranches(repoId: RepoId): Promise<string[]>;
  prepareHotCopy(repoId: RepoId, onEvent?: OnEvent, opts?: { signal?: AbortSignal }): Promise<void>;
  refreshPreparedCopy(
    repoId: RepoId,
    opts?: { signal?: AbortSignal; skipIfFresh?: boolean },
  ): Promise<void>;
  awaitPendingRefresh(repoId: RepoId): Promise<void>;
  dispose?(): void;
  create(
    input: {
      repoId: RepoId;
      branch: string;
      slug?: string;
      baseRef?: string;
      source?: { kind: "pull"; number: number };
    },
    onEvent?: OnEvent,
  ): Promise<Worktree>;
  runPostCreateHooks(worktreeId: WorktreeId, onEvent?: OnEvent): Promise<void>;
  delete(worktreeId: WorktreeId, onEvent?: OnEvent): Promise<void>;
  touch(worktreeId: WorktreeId): Promise<void>;
}

export interface PrService {
  findByBranch(repoId: RepoId, branch: string): Promise<PullRequest | undefined>;
  load(
    repoIds: RepoId[],
    tab: PrTab,
    opts: {
      force?: boolean;
      onSlice: (repoId: RepoId, slice: PrRepoSlice) => void;
    },
  ): Promise<void>;
}

export interface SessionService {
  mount(worktree: Worktree): Promise<void>;
  open(worktree: Worktree, opts?: { sleepPrevious?: boolean }): Promise<void>;
  unmount(worktree: Worktree): Promise<UnmountReport>;
  kill(worktree: Worktree): Promise<void>;
}

export interface UnmountReport {
  kept: Array<{ window: string; reason: string }>;
  closed: string[];
  sessionKilled: boolean;
}

export interface RemoteHostService {
  list(hostId: HostId): Promise<{
    protocol: number;
    version: string;
    repos: Repo[];
    worktrees: Worktree[];
  }>;
  create(
    hostId: HostId,
    input: { repo: Repo; slug: string; branch?: string; baseRef: string },
  ): Promise<{ created: boolean; worktree: Worktree }>;
  delete(hostId: HostId, worktreeId: WorktreeId): Promise<{ ok: boolean; reason?: string }>;
  kill(hostId: HostId, worktreeId: WorktreeId): Promise<void>;
  sleep(hostId: HostId, session: string): Promise<UnmountReport>;
  status(hostId: HostId): Promise<WorktreeStatus[]>;
  inspect(
    hostId: HostId,
    worktreeIds: WorktreeId[],
    opts?: { fetch?: boolean },
  ): Promise<WorktreeInspection[]>;
  sync(hostId: HostId): Promise<Worktree[]>;
  syncAll(): Promise<Array<{ hostId: HostId; error?: SwarmError }>>;
  remoteSnapshot(hostId: HostId): Promise<Map<WorktreeId, WorktreeStatus>>;
  lastError(hostId: HostId): SwarmError | undefined;
}

export interface StatusService {
  snapshot(worktrees: Worktree[]): Promise<Map<WorktreeId, WorktreeStatus>>;
}

export interface InspectionService {
  inspect(input?: {
    worktreeIds?: WorktreeId[];
    repoId?: RepoId;
    fetch?: boolean;
  }): Promise<WorktreeInspection[]>;
}

export interface FuzzyMatch<T> {
  item: T;
  score: number;
  positions: number[];
}

export type FuzzyFilter = <T>(
  query: string,
  items: T[],
  key: (item: T) => string,
) => FuzzyMatch<T>[];
