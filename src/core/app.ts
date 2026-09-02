import type {
  CloneJob,
  Config,
  Context,
  ContextId,
  PrRepoSlice,
  PrTab,
  PullRequest,
  RemoteRepo,
  Repo,
  RepoId,
  Worktree,
  WorktreeId,
  WorktreeStatus,
} from "./types.ts";

export type Pane = "repos" | "worktrees";
export type Mode = "normal" | "filter" | "dialog";

export type DialogKind =
  | {
      kind: "confirm";
      title: string;
      body: string[];
      danger?: boolean;
      confirmLabel?: string;
      onConfirm: () => void;
    }
  | { kind: "create-worktree"; repoId: RepoId; branches: string[] }
  | { kind: "clone-repo"; contextId: ContextId }
  | { kind: "context-form"; contextId?: ContextId }
  | { kind: "assign-context"; repoId: RepoId }
  | { kind: "settings" }
  | { kind: "help" }
  | { kind: "palette" };

export interface Toast {
  id: string;
  level: "info" | "success" | "error";
  text: string;
}

export interface Operation {
  id: string;
  label: string;
  step: string;
  log: string[];
  targetId?: string;
  startedAt: number;
}

export interface AppState {
  contexts: Context[];
  repos: Repo[];
  clones: CloneJob[];
  worktrees: Worktree[];
  statuses: Record<WorktreeId, WorktreeStatus>;
  activeContextId?: ContextId;
  screen: "main" | "prs";
  prTab: PrTab;
  prCursor: number;
  prFilter: string;
  prScope: { kind: "all" } | { kind: "repo"; repoId: RepoId };
  prs: Record<PrTab, Record<RepoId, PrRepoSlice>>;
  pane: Pane;
  mode: Mode;
  repoCursor: number;
  worktreeCursor: number;
  filter: string;
  dialog?: DialogKind;
  operations: Operation[];
  toasts: Toast[];
  currentSession?: string;
  loading: boolean;
  error?: string;
  config: Config;
}

export interface Store {
  getState(): AppState;
  subscribe(listener: (state: AppState) => void): () => void;
  dispatch(action: Action): void;
}

export type Action =
  | { type: "hydrate"; state: Partial<AppState> }
  | { type: "statuses"; statuses: Record<WorktreeId, WorktreeStatus> }
  | { type: "move"; pane?: Pane; delta: number }
  | { type: "moveTo"; pane?: Pane; index: number }
  | { type: "focus"; pane: Pane }
  | { type: "setMode"; mode: Mode }
  | { type: "setFilter"; filter: string }
  | {
      type: "setScreen";
      screen: AppState["screen"];
      scope?: AppState["prScope"];
      cursor?: number;
    }
  | { type: "setPrTab"; tab: PrTab }
  | { type: "setPrFilter"; filter: string }
  | { type: "prSlice"; tab: PrTab; repoId: RepoId; slice: PrRepoSlice }
  | { type: "setContext"; contextId: ContextId }
  | { type: "openDialog"; dialog: DialogKind }
  | { type: "closeDialog" }
  | { type: "opStart"; op: Operation }
  | { type: "opStep"; id: string; step: string; line?: string }
  | { type: "opEnd"; id: string }
  | { type: "toast"; toast: Toast }
  | { type: "dismissToast"; id: string }
  | { type: "setError"; error?: string }
  | { type: "setConfig"; config: Config }
  | { type: "setCurrentSession"; session?: string };

export interface Selectors {
  visibleRepos(state: AppState): Repo[];
  visibleWorktrees(state: AppState): Worktree[];
  selectedRepo(state: AppState): Repo | undefined;
  selectedWorktree(state: AppState): Worktree | undefined;
  prsInScope(state: AppState, tab: PrTab): PullRequest[];
  prErrorsInScope(state: AppState, tab: PrTab): Array<{ repoId: RepoId; error: string }>;
  prLoadingInScope(state: AppState, tab: PrTab): boolean;
  selectedPr(state: AppState): PullRequest | undefined;
  prWorktree(state: AppState, pr: PullRequest): Worktree | undefined;
  worktreePr(state: AppState, worktree: Worktree): PullRequest | undefined;
  reviewCount(state: AppState): number;
  prHints(state: AppState): Array<{ key: string; label: string }>;
}

export interface Controller {
  init(): Promise<void>;
  refresh(): Promise<void>;
  setContext(id: ContextId): Promise<void>;
  openSelected(opts?: { sleepPrevious?: boolean }): Promise<void>;
  sleepSelected(): Promise<void>;
  killSelected(): Promise<void>;
  createWorktree(input: { repoId: RepoId; branch: string; baseRef?: string }): Promise<void>;
  remoteBranches(repoId: RepoId): Promise<string[]>;
  deleteSelected(): Promise<void>;
  cloneRepo(remote: RemoteRepo): Promise<void>;
  searchRemote(query: string, signal?: AbortSignal): Promise<RemoteRepo[]>;
  assignRepo(repoId: RepoId, contextId: ContextId): Promise<void>;
  saveContext(input: { id?: ContextId; name: string; owners: string[] }): Promise<void>;
  deleteContext(id: ContextId): Promise<void>;
  saveConfig(patch: Partial<Config>): Promise<void>;
  getConfig(): Config;
  yankPath(): Promise<void>;
  openPrs(): Promise<void>;
  refreshPrs(opts: { force: boolean }): Promise<void>;
  openSelectedPr(opts: { keepPrevious: boolean }): Promise<void>;
  browseSelectedPr(): Promise<void>;
  yankSelectedPr(): Promise<void>;
  backToMain(): void;
  setPrTab(tab: PrTab): void;
  dispose(): void;
}

export interface KeyEvent {
  name: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  sequence: string;
}

export type Command =
  | "down"
  | "up"
  | "top"
  | "bottom"
  | "halfDown"
  | "halfUp"
  | "left"
  | "right"
  | "prs"
  | "back"
  | "nextTab"
  | "prevTab"
  | "browse"
  | "open"
  | "openKeep"
  | "new"
  | "newContext"
  | "delete"
  | "deleteContext"
  | "sleep"
  | "kill"
  | "move"
  | "refresh"
  | "filter"
  | "palette"
  | "settings"
  | "help"
  | "yank"
  | "quit"
  | "nextContext"
  | "prevContext"
  | `context:${number}`
  | "clearFilter"
  | "none";

export type ResolveKey = (
  mode: Mode,
  pending: string,
  event: KeyEvent,
  context: { hasFilter: boolean; screen: AppState["screen"] },
) => { command: Command; pending: string };

export interface UiDeps {
  store: Store;
  controller: Controller;
  config: Config;
}

export type UiExit = "quit" | "opened";
