import type {
  Config,
  HostConfigEntry,
  HostId,
  InspectionPullRequest,
  PrTab,
  PullRequest,
  RemoteRepo,
  State,
} from "./types.ts";

export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStderrLine?: (line: string) => void;
}

export interface Shell {
  run(cmd: string, args: string[], opts?: RunOptions): Promise<ShellResult>;
  runDetachedLogged(
    cmd: string,
    args: string[],
    opts: { cwd: string; logPath: string },
  ): Promise<number>;
  spawnDetached(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; logPath?: string },
  ): Promise<number>;
  exec(cmd: string, args: string[]): Promise<never>;
}

export interface RemoteHostPort {
  run(
    host: HostConfigEntry & { id: HostId },
    args: string[],
    opts?: { timeoutMs?: number },
  ): Promise<ShellResult>;
}

export type UpdateEvent = { type: "step"; label: string } | { type: "log"; line: string };

export interface UpdaterPort {
  update(installRoot: string, onEvent?: (event: UpdateEvent) => void): Promise<void>;
}

export interface LifecyclePort {
  requestExit(code: number): void;
}

export interface Logger {
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  child(scope: string): Logger;
  flush(): Promise<void>;
}

export interface GitPort {
  cloneDetached(url: string, dest: string, logPath: string): Promise<number>;
  fetch(repoPath: string, opts?: { prune?: boolean; signal?: AbortSignal }): Promise<void>;
  fetchRefs(repoPath: string, remote: string, refs: string[], signal?: AbortSignal): Promise<void>;
  defaultBranch(
    repoPath: string,
    hint?: string,
    signal?: AbortSignal,
    knownRemoteBranches?: string[],
  ): Promise<string>;
  resetToRemote(repoPath: string, branch: string, signal?: AbortSignal): Promise<void>;
  checkoutNewBranch(path: string, branch: string, from: string): Promise<void>;
  checkoutResetBranch(path: string, branch: string, from: string): Promise<void>;
  checkoutTracking(path: string, branch: string): Promise<void>;
  fetchPullHead(path: string, number: number): Promise<void>;
  remoteBranches(repoPath: string, signal?: AbortSignal): Promise<string[]>;
  revision(path: string, ref: string, signal?: AbortSignal): Promise<string>;
  currentBranch(path: string): Promise<string>;
  upstream(path: string): Promise<{ ref: string | null; gone: boolean }>;
  aheadBehind(path: string, upstream: string): Promise<{ ahead: number; behind: number }>;
  commitCount(path: string, range: string): Promise<number>;
  refExists(path: string, ref: string): Promise<boolean>;
  isAncestor(path: string, ancestor: string, descendant: string): Promise<boolean>;
  isDirty(path: string, opts?: { signal?: AbortSignal }): Promise<boolean>;
}

export interface FilesPort {
  exists(p: string): Promise<boolean>;
  ensureDir(p: string): Promise<void>;
  cloneTree(src: string, dest: string): Promise<void>;
  cloneTreeDetached(
    src: string,
    staging: string,
    dest: string,
    pidPath: string,
    logPath: string,
    opts: { markerText: string; prepareCommands: string[] },
  ): Promise<number>;
  move(src: string, dest: string): Promise<void>;
  removeTree(p: string): Promise<void>;
  removeDetached(p: string): Promise<void>;
  readText(p: string): Promise<string | null>;
  writeTextAtomic(p: string, text: string): Promise<void>;
  listDirs(p: string, opts?: { includeReserved?: boolean }): Promise<string[]>;
}

export interface TmuxPane {
  id: string;
  pid: number;
  currentCommand: string;
  currentPath: string;
}

export interface TmuxWindow {
  session: string;
  index: number;
  name: string;
  active: boolean;
  panes: TmuxPane[];
}

export interface TmuxSession {
  name: string;
  attached: boolean;
  windows: number;
  createdAt: number;
  lastActivityAt: number;
}

export interface TmuxPort {
  insideTmux(): boolean;
  currentSession(): Promise<string | null>;
  listSessions(): Promise<TmuxSession[]>;
  listWindows(session?: string): Promise<TmuxWindow[]>;
  hasSession(name: string): Promise<boolean>;
  newSession(opts: {
    name: string;
    windowName: string;
    cwd?: string;
    command?: string;
  }): Promise<void>;
  newWindow(opts: { session: string; name: string; cwd: string }): Promise<number>;
  sendKeys(target: string, keys: string[], opts?: { enter?: boolean }): Promise<void>;
  swapWindows(session: string, a: number, b: number): Promise<void>;
  selectWindow(session: string, index: number): Promise<void>;
  killWindow(session: string, index: number): Promise<void>;
  killSession(name: string): Promise<void>;
  killSessionIfPresent(name: string): Promise<void>;
  setOption(target: string, name: string, value: string): Promise<void>;
  switchClient(session: string): Promise<void>;
  attach(session: string): Promise<never>;
  displayMessage(msg: string): Promise<void>;
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  command: string;
}

export interface ProcessPort {
  snapshot(): Promise<ProcInfo[]>;
  descendants(root: number, snapshot: ProcInfo[]): ProcInfo[];
  listeningPorts(pids: number[]): Promise<Map<number, number[]>>;
  isAlive(pid: number): Promise<boolean>;
  openUrl(url: string): Promise<void>;
}

export interface GithubPort {
  viewer(): Promise<{ login: string }>;
  listRepos(owner: string, opts?: { signal?: AbortSignal; force?: boolean }): Promise<RemoteRepo[]>;
  findPullRequest(
    repo: { owner: string; name: string },
    branch: string,
  ): Promise<PullRequest | undefined>;
  findLatestPullRequest(
    repo: { owner: string; name: string },
    branch: string,
  ): Promise<InspectionPullRequest | undefined>;
  readCachedPullRequests(
    repo: { owner: string; name: string },
    tab: PrTab,
    opts?: { ttlSeconds?: number },
  ): Promise<{ prs: PullRequest[]; fetchedAt: string; stale: boolean } | undefined>;
  listPullRequests(
    repo: { owner: string; name: string },
    tab: PrTab,
    opts?: { signal?: AbortSignal },
  ): Promise<{ prs: PullRequest[]; fetchedAt: string }>;
}

export interface StatePort {
  load(): Promise<State>;
  save(state: State): Promise<void>;
}

export interface ConfigPort {
  load(): Promise<Config>;
  save(config: Config): Promise<void>;
}

export interface Clock {
  now(): Date;
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface Clipboard {
  copy(text: string): Promise<void>;
}
