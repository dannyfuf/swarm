import type { Config, RemoteRepo, State } from "./types.ts";

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
  spawnDetached(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; logPath?: string },
  ): Promise<number>;
  exec(cmd: string, args: string[]): Promise<never>;
}

export interface Logger {
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  child(scope: string): Logger;
}

export interface GitPort {
  cloneDetached(url: string, dest: string, logPath: string): Promise<number>;
  fetch(repoPath: string, opts?: { prune?: boolean; signal?: AbortSignal }): Promise<void>;
  defaultBranch(repoPath: string): Promise<string>;
  resetToRemote(repoPath: string, branch: string): Promise<void>;
  checkoutNewBranch(path: string, branch: string, from: string): Promise<void>;
  checkoutTracking(path: string, branch: string): Promise<void>;
  remoteBranches(repoPath: string): Promise<string[]>;
  currentBranch(path: string): Promise<string>;
  isDirty(path: string, opts?: { signal?: AbortSignal }): Promise<boolean>;
}

export interface FilesPort {
  exists(p: string): Promise<boolean>;
  ensureDir(p: string): Promise<void>;
  cloneTree(src: string, dest: string): Promise<void>;
  move(src: string, dest: string): Promise<void>;
  removeDetached(p: string): Promise<void>;
  readText(p: string): Promise<string | null>;
  writeTextAtomic(p: string, text: string): Promise<void>;
  listDirs(p: string): Promise<string[]>;
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
  newSession(opts: { name: string; cwd: string; windowName: string }): Promise<void>;
  newWindow(opts: { session: string; name: string; cwd: string }): Promise<number>;
  sendKeys(target: string, keys: string[], opts?: { enter?: boolean }): Promise<void>;
  swapWindows(session: string, a: number, b: number): Promise<void>;
  selectWindow(session: string, index: number): Promise<void>;
  killWindow(session: string, index: number): Promise<void>;
  killSession(name: string): Promise<void>;
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
}

export interface GithubPort {
  viewer(): Promise<{ login: string }>;
  listRepos(owner: string, opts?: { signal?: AbortSignal; force?: boolean }): Promise<RemoteRepo[]>;
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
