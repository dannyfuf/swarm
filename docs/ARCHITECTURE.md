# swarm — architecture and contracts

swarm is a keyboard-driven TUI that runs inside a single tmux popup and orchestrates
development "worktrees" (copy-on-write copies of a base clone, one tmux session each).
tmux is the engine; swarm is the control panel. This document is the source of truth for
every module boundary. Implementation agents work against the contracts here and must not
change a contract without recording it in `INTEGRATION NOTES`.

## 1. Product model

- **Context**: a named group of repos (e.g. `buk`, `personal`). Has GitHub owners used to
  scope remote repo search (e.g. `bukhr`, `dannyfuf`).
- **Repo**: a base clone of a remote, stored under `reposDir/<owner>/<name>`. The base is
  *pristine*: nobody works in it. It is only fetched and reset to the remote.
- **Worktree**: a copy-on-write copy of the base (`worktreesDir/<owner>/<name>/<slug>`)
  with its own branch, and exactly one tmux session named `<name>/<slug>`.
  Not a `git worktree`: a full independent copy (APFS `cp -c` clonefile / reflink).
- **Mount** a worktree = ensure its tmux session exists with the configured windows
  (default: `nvim`, `cc` → `claude`, `lg` → `lazygit`) and switch the client to it.
- **Unmount / sleep** a worktree = apply the sleep policy to its session: keep windows whose
  process tree matches a keep-alive rule (default: `claude`, `opencode`, `codex`, and any
  process listening on a TCP port); gracefully close the rest (nvim gets `:qa`; if it refuses
  because of unsaved buffers, its window is kept). A session left with no windows is killed.
- Switching from worktree A to B via the TUI = mount B, switch client, then unmount A.
  `O` (capital) switches without unmounting A. Sleep policy is configurable in the settings
  dialog (`,`).

## 2. Filesystem layout (`SWARM_HOME`, default `~/.swarm`)

```
~/.swarm/
  config.json                  user config (Config schema)
  state.json                   registry (State schema); atomic writes (tmp + rename)
  repos/<owner>/<name>/        pristine base clones           (config.reposDir)
  worktrees/<owner>/<name>/<slug>/   worktree copies           (config.worktreesDir)
  trash/<epochms>-<slug>/      deleted worktrees/repos land here by rename, rm -rf runs detached
  cache/github/<owner>.json    cached `gh repo list` results with fetchedAt
  logs/swarm.log               append-only log (adapters + operations)
```

## 3. Runtime and repo layout

Runtime: **Node ≥ 26.4 with `--experimental-ffi`** (OpenTUI's native library loads through
`node:ffi`; Deno has no `node:ffi`, and Bun is excluded by policy). Verified 2026-09-02 with
Node 26.8.1 + `@opentui/core`/`@opentui/react` 0.5.10 + React 19. TypeScript runs through
`tsx` (`node --experimental-ffi --import tsx src/main.ts`); `npm run build` bundles with esbuild
to `dist/swarm.mjs` for fast popup start-up (`bin/swarm` prefers `dist/` when present).
Validation: `zod` v4. Tests: `node --test` (+ tsx). Lint/format: biome. Package manager: npm.
`.nvmrc` pins 26.8.1; `bin/swarm` falls back to the newest `~/.nvm/versions/node/v26*` when the
`node` on PATH is older than 26.4.

```
bin/swarm                 launcher (exec runtime with src/main.ts, passes args)
tmux/tmux.conf            full tmux config (theme, persistence) with the ONE swarm binding: prefix+s → popup (replaces the default session chooser)
src/main.ts               CLI entry: `swarm` (TUI), `swarm open <repo>/<slug>`, `swarm sleep <session>`, `swarm doctor`
src/core/                 contracts and pure helpers; no I/O
  types.ts                domain zod schemas + inferred types (section 4)
  ports.ts                infrastructure port interfaces (section 5)
  services.ts             service interfaces + operation events (section 6)
  app.ts                  AppState, Action, Store, Keymap contracts (section 7)
  fuzzy.ts                pure fuzzy matching shared by services and UI
  paths.ts                pure helpers: swarmHome(), slugify(), sessionName(), repoId(), worktreeId()
  errors.ts               SwarmError with `code` union
src/adapters/             one file per port, shell-based; each has *.test.ts using FakeShell
src/services/             one file per service interface; tests use fakes from src/testing
src/app/                  store.ts (createStore), keymap.ts, controller.ts (wires services→store)
src/ui/                   OpenTUI React components; depends only on src/core
src/testing/              fakes for every port (FakeShell, FakeGit, FakeFiles, FakeTmux, FakeProcess, FakeGithub, MemoryState, MemoryConfig) and fixtures
docs/                     this file, KEYMAP.md
```

Dependency rule (enforced by review): `core` imports nothing internal. `adapters`, `services`,
`app`, `ui` import `core`. `ui` never imports `services`/`adapters`. Fuzzy matching lives in
`core` because both services and UI need it, and the UI may import core but not services.
`main.ts` is the only composition root.

## 4. Domain types (`src/core/types.ts`) — zod schemas, export both schema and type

```ts
export const ContextId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
export const RepoId = z.string().regex(/^[^/\s]+\/[^/\s]+$/);        // "owner/name"
export const WorktreeId = z.string().regex(/^[^/\s]+\/[^/\s]+#[^\s#]+$/); // "owner/name#slug"

export const ContextSchema = z.object({
  id: ContextId,                 // slug of name
  name: z.string().min(1),
  owners: z.array(z.string()),   // GitHub owners (users/orgs) to search when cloning
  createdAt: z.string().datetime(),
});

export const RepoSchema = z.object({
  id: RepoId,                    // "owner/name"
  owner: z.string(), name: z.string(),
  url: z.string(),               // clone URL selected by github.cloneProtocol
  contextId: ContextId,
  defaultBranch: z.string(),     // detected after clone (origin/HEAD)
  path: z.string(),              // absolute base clone path
  clonedAt: z.string().datetime(),
  hooks: z.object({ postCreate: z.array(z.string()).default([]) }).default({ postCreate: [] }),
});

export const CloneJobSchema = z.object({
  id: RepoId, owner: z.string(), name: z.string(), url: z.string(), contextId: ContextId,
  defaultBranch: z.string(), path: z.string(), stagingPath: z.string(), logPath: z.string(),
  pid: z.number().int().positive().optional(), startedAt: z.string().datetime(),
  status: z.enum(["starting", "cloning", "failed"]), error: z.string().optional(),
});

export const WorktreeSchema = z.object({
  id: WorktreeId,                // "owner/name#slug"
  repoId: RepoId,
  slug: z.string(),              // slugify(branch)
  branch: z.string(),
  baseRef: z.string(),           // e.g. "origin/main"
  path: z.string(),              // absolute
  session: z.string(),           // tmux session name = sessionName(repo.name, slug)
  createdAt: z.string().datetime(),
  lastOpenedAt: z.string().datetime().optional(),
});

export const StateSchema = z.object({
  version: z.literal(1),
  contexts: z.array(ContextSchema),
  repos: z.array(RepoSchema),
  clones: z.array(CloneJobSchema).default([]),
  worktrees: z.array(WorktreeSchema),
  activeContextId: ContextId.optional(),
});

export const WindowSpecSchema = z.object({ name: z.string().min(1), command: z.string().min(1) });
export const KeepAliveRuleSchema = z.object({
  id: z.string(), label: z.string(),
  kind: z.enum(["process", "listening-port"]),
  pattern: z.string().default(""),   // regex tested against full command line (process kind)
  enabled: z.boolean().default(true),
});
export const SleepPolicySchema = z.object({
  enabled: z.boolean().default(true),
  keepAlive: z.array(KeepAliveRuleSchema),
  graceMs: z.number().int().default(2000),   // wait after graceful close before giving up
});
export const ConfigSchema = z.object({
  version: z.literal(1),
  reposDir: z.string(), worktreesDir: z.string(),       // absolute; defaults under SWARM_HOME
  windows: z.array(WindowSpecSchema),                     // default nvim/cc/lg
  sleep: SleepPolicySchema,
  github: z.object({
    cacheTtlSeconds: z.number().int().default(3600),
    cloneProtocol: z.enum(["ssh", "https"]).default("ssh"),
  }).default({ cacheTtlSeconds: 3600, cloneProtocol: "ssh" }),
  ui: z.object({ statusRefreshMs: z.number().int().default(2000) }).default({ statusRefreshMs: 2000 }),
});
export function defaultConfig(home: string): Config;   // fills all defaults
export function defaultState(): State;

// Runtime (computed, never persisted)
export type SessionState = "none" | "detached" | "attached";
export interface WorktreeStatus {
  worktreeId: WorktreeId;
  session: SessionState;
  windows: Array<{ index: number; name: string; command: string; keepAlive: string[] }>; // keepAlive = matched rule labels
  running: string[];        // de-duplicated keep-alive labels across windows, e.g. ["claude", ":3000"]
}
export interface RemoteRepo { owner: string; name: string; fullName: string; description: string; sshUrl: string; isPrivate: boolean; updatedAt: string; defaultBranch: string; }
```

Errors (`src/core/errors.ts`): `class SwarmError extends Error { code: ErrorCode; cause?: unknown }`,
`ErrorCode = "not-found" | "conflict" | "git" | "tmux" | "fs" | "github" | "validation" | "cancelled" | "unsupported"`.

Pure helpers (`src/core/paths.ts`):
- `swarmHome(env)` → `env.SWARM_HOME ?? join(env.HOME, ".swarm")`
- `slugify(branch)` → lowercase, `/` and non `[a-z0-9._-]` → `-`, collapse, trim `-`; e.g. `feat/Payroll Fix` → `feat-payroll-fix`
- `sessionName(repoName, slug)` → `${repoName}/${slug}` with `.` and `:` replaced by `-` (tmux forbids them)
- `repoId(owner, name)`, `worktreeId(repoId, slug)`, `parseWorktreeId(id)`
- `repoPath(config, owner, name)`, `worktreePath(config, owner, name, slug)`

## 5. Ports (`src/core/ports.ts`)

All adapters shell out through `Shell` so they are testable with `FakeShell`.

```ts
export interface ShellResult { code: number; stdout: string; stderr: string }
export interface RunOptions { cwd?: string; env?: Record<string,string>; input?: string; timeoutMs?: number; signal?: AbortSignal; onStderrLine?: (line: string) => void }
export interface Shell {
  run(cmd: string, args: string[], opts?: RunOptions): Promise<ShellResult>;           // never throws on non-zero exit
  spawnDetached(cmd: string, args: string[], opts?: { cwd?: string; logPath?: string }): Promise<number>; // new process group, ignored stdin, optional file-backed stdout/stderr, unref
  exec(cmd: string, args: string[]): Promise<never>;                                   // replace current process stdio (tmux attach outside tmux)
}
export interface Logger { info(msg: string, data?: unknown): void; warn(...): void; error(...): void; child(scope: string): Logger }

export interface GitPort {
  cloneDetached(url: string, dest: string, logPath: string): Promise<number>;
  fetch(repoPath: string, opts?: { prune?: boolean; signal?: AbortSignal }): Promise<void>;
  defaultBranch(repoPath: string): Promise<string>;                 // from refs/remotes/origin/HEAD, fallback main/master
  resetToRemote(repoPath: string, branch: string): Promise<void>;   // checkout -B branch origin/branch && reset --hard origin/branch && clean -fd
  checkoutNewBranch(path: string, branch: string, from: string): Promise<void>;  // checkout -b branch from
  checkoutTracking(path: string, branch: string): Promise<void>;    // checkout branch (tracks origin/branch)
  remoteBranches(repoPath: string): Promise<string[]>;             // "origin/x" names, without HEAD
  currentBranch(path: string): Promise<string>;
  isDirty(path: string, opts?: { signal?: AbortSignal }): Promise<boolean>;
}
export interface FilesPort {
  exists(p: string): Promise<boolean>;
  ensureDir(p: string): Promise<void>;
  cloneTree(src: string, dest: string): Promise<void>;   // darwin: cp -Rc ; linux: cp -R --reflink=auto ; fallback cp -R
  move(src: string, dest: string): Promise<void>;        // rename
  removeDetached(p: string): Promise<void>;              // spawnDetached rm -rf
  readText(p: string): Promise<string | null>;
  writeTextAtomic(p: string, text: string): Promise<void>;
  listDirs(p: string): Promise<string[]>;
}
export interface TmuxPane { id: string; pid: number; currentCommand: string; currentPath: string }
export interface TmuxWindow { session: string; index: number; name: string; active: boolean; panes: TmuxPane[] }
export interface TmuxSession { name: string; attached: boolean; windows: number; createdAt: number; lastActivityAt: number }
export interface TmuxPort {
  insideTmux(): boolean;
  currentSession(): Promise<string | null>;
  listSessions(): Promise<TmuxSession[]>;
  listWindows(session?: string): Promise<TmuxWindow[]>;   // one `list-panes -a` call, grouped; session filter optional
  hasSession(name: string): Promise<boolean>;
  newSession(opts: { name: string; cwd: string; windowName: string }): Promise<void>;   // detached, shell only
  newWindow(opts: { session: string; name: string; cwd: string }): Promise<number>;     // returns index; shell only
  sendKeys(target: string, keys: string[], opts?: { enter?: boolean }): Promise<void>;
  swapWindows(session: string, a: number, b: number): Promise<void>;
  selectWindow(session: string, index: number): Promise<void>;
  killWindow(session: string, index: number): Promise<void>;
  killSession(name: string): Promise<void>;
  switchClient(session: string): Promise<void>;           // uses -t "=name" exact match
  attach(session: string): Promise<never>;                // outside tmux: exec tmux attach
  displayMessage(msg: string): Promise<void>;
}
export interface ProcInfo { pid: number; ppid: number; command: string }
export interface ProcessPort {
  snapshot(): Promise<ProcInfo[]>;                                  // single `ps -axo pid=,ppid=,command=`
  descendants(root: number, snapshot: ProcInfo[]): ProcInfo[];     // pure, includes root if present
  listeningPorts(pids: number[]): Promise<Map<number, number[]>>;  // single lsof call
  isAlive(pid: number): Promise<boolean>;
}
export interface GithubPort {
  viewer(): Promise<{ login: string }>;
  listRepos(owner: string, opts?: { signal?: AbortSignal; force?: boolean }): Promise<RemoteRepo[]>;  // force bypasses the cache
}
export interface StatePort  { load(): Promise<State>;  save(state: State): Promise<void> }   // validated, atomic
export interface ConfigPort { load(): Promise<Config>; save(config: Config): Promise<void> }
export interface Clock { now(): Date; setInterval(callback: () => void, intervalMs: number): unknown; clearInterval(handle: unknown): void }
export interface Clipboard { copy(text: string): Promise<void> }   // pbcopy / xclip / wl-copy
```

## 6. Services (`src/core/services.ts`)

Long-running operations report progress through `OpEvent` callbacks; they never touch the UI.

```ts
export type OpEvent =
  | { type: "step"; label: string }              // "Fetching origin", "Copying tree", "Creating branch"
  | { type: "log"; line: string }
  | { type: "done" } | { type: "error"; error: SwarmError };
export type OnEvent = (e: OpEvent) => void;

export interface ContextService {
  list(): Promise<Context[]>;
  create(input: { name: string; owners: string[] }): Promise<Context>;       // conflict if id exists
  update(id: ContextId, patch: Partial<Pick<Context,"name"|"owners">>): Promise<Context>;
  delete(id: ContextId, onEvent?: OnEvent): Promise<void>;                     // cascades repos + worktrees + sessions
  setActive(id: ContextId): Promise<void>;
}
export interface RepoService {
  list(contextId?: ContextId): Promise<Repo[]>;
  searchRemote(contextId: ContextId, query: string, opts?: { refresh?: boolean; signal?: AbortSignal }): Promise<RemoteRepo[]>; // fuzzy over cached owners lists, excludes already-cloned
  clone(remote: RemoteRepo, contextId: ContextId, onEvent?: OnEvent): Promise<CloneJob>; // persists, then launches detached using github.cloneProtocol
  reconcileClones(): Promise<CloneJob[]>; // running pid stays pending; completed .git is promoted; missing .git becomes failed
  assign(repoId: RepoId, contextId: ContextId): Promise<Repo>;
  delete(repoId: RepoId, onEvent?: OnEvent): Promise<void>;                    // kills sessions, trashes worktrees + base
}
export interface WorktreeService {
  list(repoId?: RepoId): Promise<Worktree[]>;
  remoteBranches(repoId: RepoId): Promise<string[]>;
  create(input: { repoId: RepoId; branch: string; baseRef?: string }, onEvent?: OnEvent): Promise<Worktree>;
    // steps: fetch base → resetToRemote(default) → cloneTree → (origin/branch exists ? checkoutTracking : checkoutNewBranch from baseRef ?? origin/default) → hooks.postCreate → persist
  delete(worktreeId: WorktreeId, onEvent?: OnEvent): Promise<void>;           // killSession → move to trash → removeDetached → persist
  touch(worktreeId: WorktreeId): Promise<void>;                                // lastOpenedAt = now
}
export interface SessionService {
  mount(worktree: Worktree): Promise<void>;        // ensure session + windows in configured order (append missing, swap into place, select first)
  open(worktree: Worktree, opts?: { sleepPrevious?: boolean }): Promise<void>; // mount → touch → switchClient/attach → if sleepPrevious (default true) unmount previous swarm session
  unmount(worktree: Worktree): Promise<UnmountReport>;  // apply sleep policy
  kill(worktree: Worktree): Promise<void>;
}
export interface UnmountReport { kept: Array<{ window: string; reason: string }>; closed: string[]; sessionKilled: boolean }
export interface StatusService {
  snapshot(worktrees: Worktree[]): Promise<Map<WorktreeId, WorktreeStatus>>;  // 1 tmux call + 1 ps + ≤1 lsof
}
export interface FuzzyMatch<T> { item: T; score: number; positions: number[] }
export type FuzzyFilter = <T>(query: string, items: T[], key: (t: T) => string) => FuzzyMatch<T>[];
export const fuzzyFilter: FuzzyFilter; // src/core/fuzzy.ts, pure, fzf-like (subsequence, bonus for word starts / consecutive), empty query → all in input order
```

Repository clones run in a detached process group and are first written to a unique sibling
directory named `<destination>.staging-<pid>-<uuid>`. Before launch, the service persists a
`CloneJob`; after spawn it records the child pid. Child stdout/stderr append to a per-clone file
under `SWARM_HOME/logs`. On startup/refresh, and every two seconds while an active clone remains,
reconciliation leaves live pids pending, detects a finished clone by its `.git`, detects the
default branch, then atomically renames the complete clone into its final path and promotes the
job to a `Repo`. A dead child without a valid clone is marked failed and only its own staging
directory is removed. `github.cloneProtocol` selects
`remote.sshUrl` or `https://github.com/<owner>/<name>.git`; the selected URL is persisted.

All service state changes go through `src/services/stateMutation.ts`. It delegates to the
state adapter's transactional `mutate` extension when available; that adapter holds an
exclusive `state.json.lock` across the complete load-modify-save sequence, serializing both
in-process and cross-process writers, and writes the result atomically. Test ports without
`mutate` use a per-port in-process promise chain.

Sleep policy algorithm (`SessionService.unmount`):
1. `windows = tmux.listWindows(session)`; `procs = process.snapshot()`.
2. For each window, for each pane: `tree = process.descendants(pane.pid, procs)`; a rule of kind
   `process` matches if `new RegExp(rule.pattern, "i")` matches any `tree[i].command`; kind
   `listening-port` matches if `listeningPorts(tree pids)` is non-empty (labels `":<port>"`).
   Matched labels → window kept.
3. Unmatched window: if any pane `currentCommand` is `nvim`/`vim`: `sendKeys(pane, ["Escape", ":qa"], {enter:true})`,
   wait up to `graceMs` polling `isAlive`; still alive → keep with reason `unsaved changes`.
   Otherwise `killWindow`.
4. No windows left → `killSession`. Return `UnmountReport`.
Default keep-alive rules: `{id:"claude", label:"claude", kind:"process", pattern:"(^|/)claude( |$)"}`,
`{id:"opencode", pattern:"(^|/)opencode( |$)"}`, `{id:"codex", pattern:"(^|/)codex( |$)"}`,
`{id:"servers", label:"server", kind:"listening-port"}`.

## 7. App layer (`src/core/app.ts`) — UI contract

```ts
export type Pane = "repos" | "worktrees";
export type Mode = "normal" | "filter" | "dialog";
export type DialogKind =
  | { kind: "confirm"; title: string; body: string[]; danger?: boolean; confirmLabel?: string; onConfirm: () => void }
  | { kind: "create-worktree"; repoId: RepoId; branches: string[] }
  | { kind: "clone-repo"; contextId: ContextId }
  | { kind: "context-form"; contextId?: ContextId }
  | { kind: "assign-context"; repoId: RepoId }
  | { kind: "settings" } | { kind: "help" } | { kind: "palette" };
export interface Toast { id: string; level: "info"|"success"|"error"; text: string }
export interface Operation { id: string; label: string; step: string; log: string[]; targetId?: string; startedAt: number }
export interface AppState {
  contexts: Context[]; repos: Repo[]; clones: CloneJob[]; worktrees: Worktree[];
  statuses: Record<WorktreeId, WorktreeStatus>;
  activeContextId?: ContextId;
  pane: Pane; mode: Mode;
  repoCursor: number;             // 0 = "All" pseudo row; n > 0 selects visibleRepos[n - 1]
  worktreeCursor: number;
  filter: string;                 // active filter text (applies to worktrees pane)
  dialog?: DialogKind;
  operations: Operation[]; toasts: Toast[];
  currentSession?: string;        // tmux session the client is attached to
  loading: boolean; error?: string;
  config: Config;                 // current validated config for read-only UI display
}
export interface Store {
  getState(): AppState;
  subscribe(listener: (s: AppState) => void): () => void;
  dispatch(action: Action): void;
}
export type Action =                                    // pure reducer in src/app/store.ts
  | { type: "hydrate"; state: Partial<AppState> }
  | { type: "statuses"; statuses: Record<WorktreeId, WorktreeStatus> }
  | { type: "move"; pane?: Pane; delta: number } | { type: "moveTo"; pane?: Pane; index: number }
  | { type: "focus"; pane: Pane } | { type: "setMode"; mode: Mode }
  | { type: "setFilter"; filter: string } | { type: "setContext"; contextId: ContextId }
  | { type: "openDialog"; dialog: DialogKind } | { type: "closeDialog" }
  | { type: "opStart"; op: Operation } | { type: "opStep"; id: string; step: string; line?: string } | { type: "opEnd"; id: string }
  | { type: "toast"; toast: Toast } | { type: "dismissToast"; id: string }
  | { type: "setError"; error?: string }
  | { type: "setConfig"; config: Config } | { type: "setCurrentSession"; session?: string };
export interface Selectors {                            // src/app/selectors.ts, pure
  visibleRepos(s: AppState): Repo[];                    // repos in active context, sorted by name
  visibleWorktrees(s: AppState): Worktree[];            // repoCursor 0 → all worktrees of context sorted by lastOpenedAt desc; else repo's; then fuzzyFilter(filter)
  selectedRepo(s: AppState): Repo | undefined; selectedWorktree(s: AppState): Worktree | undefined;
}
export interface Controller {                           // src/app/controller.ts; UI calls these, never services
  init(): Promise<void>;                                // load state/config, hydrate, start status polling
  refresh(): Promise<void>;
  setContext(id: ContextId): Promise<void>;              // persist active context, then update the store
  openSelected(opts?: { sleepPrevious?: boolean }): Promise<void>;   // on success → resolves; UI exits process
  sleepSelected(): Promise<void>; killSelected(): Promise<void>;
  createWorktree(input: { repoId: RepoId; branch: string; baseRef?: string }): Promise<void>;
  remoteBranches(repoId: RepoId): Promise<string[]>;
  deleteSelected(): Promise<void>;                      // opens confirm dialog with impact summary
  cloneRepo(remote: RemoteRepo): Promise<void>; searchRemote(q: string, signal?: AbortSignal): Promise<RemoteRepo[]>;
  assignRepo(repoId: RepoId, contextId: ContextId): Promise<void>;
  saveContext(input: { id?: ContextId; name: string; owners: string[] }): Promise<void>; deleteContext(id: ContextId): Promise<void>;
  saveConfig(patch: Partial<Config>): Promise<void>; getConfig(): Config;
  yankPath(): Promise<void>;
  dispose(): void;
}
export interface KeyEvent { name: string; ctrl: boolean; shift: boolean; meta: boolean; sequence: string }
export type Command = "down"|"up"|"top"|"bottom"|"halfDown"|"halfUp"|"left"|"right"|"open"|"openKeep"|"new"|"newContext"|"delete"|"deleteContext"|"sleep"|"kill"|"move"|"refresh"|"filter"|"palette"|"settings"|"help"|"yank"|"quit"|"nextContext"|"prevContext"|`context:${number}`|"clearFilter"|"none";
export type ResolveKey = (mode: Mode, pending: string, ev: KeyEvent, ctx: { hasFilter: boolean }) => { command: Command; pending: string }; // src/app/keymap.ts; handles gg/gt/gT chords via `pending`, and ctx controls retained-filter Esc behavior
export interface UiDeps { store: Store; controller: Controller; config: Config }
export type UiExit = "quit" | "opened";
```

## 8. Keymap (normal mode; vim-relatable) — full table in `docs/KEYMAP.md`

| key | command |
|---|---|
| `j`/`k`, `↓`/`↑` | move cursor |
| `gg` / `G` | top / bottom |
| `ctrl-d` / `ctrl-u` | half page |
| `h` / `←` / `S-Tab` | focus repos pane |
| `l` / `→` / `Tab` | focus worktrees pane |
| `Enter`, `o` | open (worktree: mount+switch+quit; repo: focus worktrees) |
| `O` | open without sleeping the previous worktree |
| `n` | new (worktrees pane: create worktree for selected repo; repos pane: clone repo) |
| `N` | new context |
| `d` | delete selected (confirm with impact) |
| `D` | delete active context (confirm) |
| `s` / `K` | sleep worktree / kill session |
| `m` | move repo to another context |
| `r` | refresh |
| `/` | filter (Enter opens selected match; Esc exits input, keeps filter; Esc again clears) |
| `:` | command palette (fuzzy list of all commands + contexts) |
| `,` | settings (sleep policy; windows and clone protocol are read-only) |
| `gt` / `gT`, `1`-`9` | next / prev / nth context |
| `y` | yank worktree path |
| `?` | help overlay |
| `q`, `Esc`, `ctrl-c` | quit popup |
Dialogs: `Esc` cancel, `Enter` confirm, `Tab`/`S-Tab` fields, `ctrl-n`/`ctrl-p` or `↓`/`↑` in lists.

## 9. UI layout (popup 90%×85%)

```
╭ swarm ─────────────────────────────────────────────────────────────────────────╮
│  1 buk   2 personal                                     ● 2 live · ◌ 1 sleeping │  context tabs (active bold/underlined) · right: session summary
├──────────────────────┬─────────────────────────────────────────────────────────┤
│ REPOS                │ WORKTREES · buk-webapp                                  │
│ ▸ All          7     │ ● main               claude              2h ago         │  ● attached  ◌ session alive (agents)  ○ no session
│   buk-webapp   3 ◌   │ ◌ feat/payroll-fix   claude · :3000     1d ago         │  columns: state · branch · running · last opened
│   buk-mobile   1     │ ○ fix/1234           –                   3d ago         │
│   toolkit      0     ├─────────────────────────────────────────────────────────┤
│                      │ feat/payroll-fix · base origin/main                     │  detail of selected worktree
│                      │ ~/.swarm/worktrees/bukhr/buk-webapp/feat-payroll-fix    │
│                      │ windows  nvim · cc ⚡claude · lg                        │
├──────────────────────┴─────────────────────────────────────────────────────────┤
│ ⏎ open  n new  d delete  s sleep  / filter  : commands  , settings  ? help     │  hints for the focused pane; replaced by operation progress / toasts while active
╰────────────────────────────────────────────────────────────────────────────────╯
```

Rules: worktrees pane focused by default with "All" selected (most recently opened first) so
the common path is `prefix s` → `j`/`/…` → `Enter`. Rows show only what changes a decision:
state glyph, branch, what is running, recency. Everything else lives in the detail box.
Rows of in-flight operations show a spinner + step text instead of columns. Empty states carry
the next action ("No repos in buk — press n to clone one"). Colors: a single accent for the
cursor row, green for attached, yellow for running agents, red only for danger dialogs.

## 10. Integration notes

- 2026-09-02: repository cloning became a persisted detached background job. `Shell.spawnDetached`
  now returns a pid and can redirect output to a log; `GitPort` exposes `cloneDetached`; `State`
  and `AppState` include clone jobs; and `RepoService.reconcileClones` promotes or fails them on
  startup, refresh, or the controller's active-clone timer. Existing version-1 state remains
  compatible because `clones` defaults to an empty array. State mutations also reclaim lock files
  whose recorded process is dead or invalid, while protecting live and newly-created empty locks;
  interactive lock acquisition times out after three seconds.
