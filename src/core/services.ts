import type { SwarmError } from "./errors.ts";
import type {
  CloneJob,
  Context,
  ContextId,
  PrRepoSlice,
  PrTab,
  RemoteRepo,
  Repo,
  RepoId,
  Worktree,
  WorktreeId,
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
  clone(remote: RemoteRepo, contextId: ContextId, onEvent?: OnEvent): Promise<CloneJob>;
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
  create(
    input: {
      repoId: RepoId;
      branch: string;
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

export interface StatusService {
  snapshot(worktrees: Worktree[]): Promise<Map<WorktreeId, WorktreeStatus>>;
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
