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
- **Prepared-copy pool**: zero or more pristine-base copies with repo `prepare` hooks already run.
  Creation claims the lowest slot by rename and immediately replenishes it from the base clone.
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
  worktrees/<owner>/<name>/<slug>.creating-<uuid>/  private create attempt, never registered
  worktrees/<owner>/<name>/.hot/     prepared copy slot 0 (backward-compatible name)
    .git/swarm-hot.json         freshness marker: fetchedAt, defaultBranch, origin SHA, prepare-hook fingerprint
  worktrees/<owner>/<name>/.hot.staging/  incomplete slot 0 rebuild, never consumed
  worktrees/<owner>/<name>/.hot.<n>/       prepared copy slot n, n >= 1
  worktrees/<owner>/<name>/.hot.<n>.staging/ incomplete slot n rebuild, never consumed
  worktrees/<owner>/<name>/<slug>/.git/swarm-creating.json  publish intent, removed after state commit
  trash/<epochms>-<slug>/      deleted worktrees/repos land here by rename, rm -rf runs detached
  cache/github/<owner>.json    cached `gh repo list` results with fetchedAt
  logs/swarm.log               append-only log (adapters + operations)
```

## 3. Runtime and repo layout

Runtime: **Node ≥ 26.4 with `--experimental-ffi`** (OpenTUI's native library loads through
`node:ffi`; Deno has no `node:ffi`, and Bun is excluded by policy). Verified 2026-09-02 with
Node 26.8.1 + `@opentui/core`/`@opentui/react` 0.5.10 + React 19. TypeScript runs through
`tsx` (`node --experimental-ffi --import tsx src/main.ts`); `npm run build` bundles with esbuild
to `dist/swarm.mjs` for fast popup start-up (`bin/swarm` prefers `dist/` when present) and bakes
the package version plus current short Git SHA into the CLI.
Validation: `zod` v4. Tests: `node --test` (+ tsx). Lint/format: biome. Package manager: npm.
`.nvmrc` pins 26.8.1. `bin/swarm` honors an executable `SWARM_NODE`, then a cached Node path, a
known versioned PATH binary, or the newest compatible nvm/nodenv install. Only an otherwise opaque
PATH binary needs a version-probe process.

```
bin/swarm                 launcher (runs dist or src, restarts in place when the TUI returns 75)
tmux/tmux.conf            full tmux config (theme, persistence) with swarm and persistent agent popup bindings
src/main.ts               CLI entry: `swarm` (TUI), `swarm open <repo>/<slug>`, `swarm sleep <session>`, `swarm agent <claude|opencode>`, `swarm doctor`
src/core/                 contracts and pure helpers; no I/O
  types.ts                domain zod schemas + inferred types (section 4)
  ports.ts                infrastructure port interfaces (section 5)
  services.ts             service interfaces + operation events (section 6)
  app.ts                  AppState, Action, Store, Keymap contracts (section 7)
  fuzzy.ts                pure fuzzy matching shared by services and UI
  paths.ts                pure helpers: swarmHome(), installRoot(), slugify(), sessionName(), repoId(), worktreeId()
  errors.ts               SwarmError with `code` union
src/adapters/             one file per port, shell-based; each has *.test.ts using FakeShell
src/services/             one file per service interface; tests use fakes from src/testing
  agentPopup.ts           pure agent names/commands, tmux attach argv/socket parsing, and env stripping
src/app/                  store.ts (createStore), keymap.ts, controller.ts (wires services→store)
src/ui/                   OpenTUI React components; depends only on src/core
src/testing/              fakes for every port (FakeShell, FakeGit, FakeFiles, FakeTmux, FakeProcess, FakeGithub, MemoryState, MemoryConfig) and fixtures
docs/                     this file, KEYMAP.md
```

Dependency rule (enforced by review): `core` imports nothing internal. `adapters`, `services`,
`app`, `ui` import `core`. `ui` never imports `services`/`adapters`. Fuzzy matching lives in
`core` because both services and UI need it, and the UI may import core but not services.
`main.ts` is the only composition root.

tmux uses `prefix+s` for the control-panel popup, `prefix+a` for Claude Code, and `prefix+A`
for OpenCode. Each agent command creates or reuses `swarm-agent-<agent>` with cwd set to
`config.reposDir`, then attaches a nested client through the invoking popup's tmux socket. Global
`C-q` detaches that nested client only while an agent session is active, closing the popup while
leaving the agent and scrollback alive; reopening the same binding reattaches to that session.

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
  hooks: z.object({
    prepare: z.array(z.string()).default([]),
    postCreate: z.array(z.string()).default([]),
  }).default({ prepare: [], postCreate: [] }),
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
  hotPoolSize: z.number().int().nonnegative().default(1),
  hotFreshnessMs: z.number().int().nonnegative().default(60000),
  hotRefreshIntervalMs: z.number().int().nonnegative().default(300000),
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
- `installRoot(env, moduleUrl)` → `SWARM_INSTALL_ROOT`, or the parent of the running `src/` / `dist/` module directory
- `slugify(branch)` → lowercase, `/` and non `[a-z0-9._-]` → `-`, collapse, trim `-`; e.g. `feat/Payroll Fix` → `feat-payroll-fix`
- `sessionName(repoName, slug)` → `${repoName}/${slug}` with `.` and `:` replaced by `-` (tmux forbids them)
- `repoId(owner, name)`, `worktreeId(repoId, slug)`, `parseWorktreeId(id)`
- `repoPath(config, owner, name)`, `worktreePath(config, owner, name, slug)`
- `hotCopyPath(worktreesDir, repoId, slot = 0)`, `hotCopyStagingPath(worktreesDir, repoId, slot = 0)`

## 5. Ports (`src/core/ports.ts`)

All adapters shell out through `Shell` so they are testable with `FakeShell`.

```ts
export interface ShellResult { code: number; stdout: string; stderr: string }
export interface RunOptions { cwd?: string; env?: Record<string,string>; input?: string; timeoutMs?: number; signal?: AbortSignal; onStderrLine?: (line: string) => void }
export interface Shell {
  run(cmd: string, args: string[], opts?: RunOptions): Promise<ShellResult>;           // never throws on non-zero exit
  runDetachedLogged(cmd: string, args: string[], opts: { cwd: string; logPath: string }): Promise<number>; // detached+unref, file-backed stdout/stderr, resolves on exit
  spawnDetached(cmd: string, args: string[], opts?: { cwd?: string; logPath?: string }): Promise<number>; // new process group, ignored stdin, optional file-backed stdout/stderr, unref
  exec(cmd: string, args: string[]): Promise<never>;                                   // replace current process stdio (tmux attach outside tmux)
}
export interface Logger { info(msg: string, data?: unknown): void; warn(...): void; error(...): void; child(scope: string): Logger }

export interface GitPort {
  cloneDetached(url: string, dest: string, logPath: string): Promise<number>;
  fetch(repoPath: string, opts?: { prune?: boolean; signal?: AbortSignal }): Promise<void>;
  fetchRefs(repoPath: string, remote: string, refs: string[], signal?: AbortSignal): Promise<void>;
  defaultBranch(repoPath: string, hint?: string, signal?: AbortSignal, knownRemoteBranches?: string[]): Promise<string>; // origin/HEAD, fallback hint/main/master/known refs
  resetToRemote(repoPath: string, branch: string, signal?: AbortSignal): Promise<void>; // checkout -B + reset --hard + clean -fd
  checkoutNewBranch(path: string, branch: string, from: string): Promise<void>;  // checkout -b branch from
  checkoutTracking(path: string, branch: string): Promise<void>;    // checkout branch (tracks origin/branch)
  fetchPullHead(path: string, number: number, localBranch: string): Promise<void>;
  remoteBranches(repoPath: string, signal?: AbortSignal): Promise<string[]>; // "origin/x" names, without HEAD
  revision(path: string, ref: string, signal?: AbortSignal): Promise<string>; // rev-parse --verify
  currentBranch(path: string): Promise<string>;
  isDirty(path: string, opts?: { signal?: AbortSignal }): Promise<boolean>;
}
export interface FilesPort {
  exists(p: string): Promise<boolean>;
  ensureDir(p: string): Promise<void>;
  cloneTree(src: string, dest: string): Promise<void>;   // darwin: cp -Rc ; linux: cp -R --reflink=auto ; fallback cp -R
  move(src: string, dest: string): Promise<void>;        // rename
  removeTree(p: string): Promise<void>;                  // guarded, blocking rm for staging cleanup
  removeDetached(p: string): Promise<void>;              // spawnDetached rm -rf
  readText(p: string): Promise<string | null>;
  writeTextAtomic(p: string, text: string): Promise<void>;
  listDirs(p: string, opts?: { includeReserved?: boolean }): Promise<string[]>; // sorted directories; .hot* excluded unless requested
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
  | { type: "prepared-copy-claimed"; repoId: RepoId }
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
  reconcileCreating(): Promise<void>;
  coordinateRepoDeletion(repoId: RepoId, action: () => Promise<void>): Promise<void>;
  list(repoId?: RepoId): Promise<Worktree[]>;
  remoteBranches(repoId: RepoId): Promise<string[]>; // lowest existing slot, else base
  prepareHotCopy(repoId: RepoId, onEvent?: OnEvent, opts?: { signal?: AbortSignal }): Promise<void>;
  refreshPreparedCopy(repoId: RepoId, opts?: { signal?: AbortSignal; skipIfFresh?: boolean }): Promise<void>;
  awaitPendingRefresh(repoId: RepoId): Promise<void>;
  create(input: { repoId: RepoId; branch: string; baseRef?: string; source?: { kind: "pull"; number: number } }, onEvent?: OnEvent): Promise<Worktree>;
    // fast: rename lowest slot → private attempt → refresh/checkout/hooks → publish+persist
    // fallback: cloneTree(base, private attempt) → refresh/checkout/hooks → publish+persist
  runPostCreateHooks(worktreeId: WorktreeId, onEvent?: OnEvent): Promise<void>;
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

### Hot-copy pool

Each registered repository has `config.hotPoolSize` prepared-copy slots. Slot 0 is `.hot`; slots
1 and above are `.hot.<n>`. Every creation owns a unique sibling
`<slug>.creating-<uuid>` directory. It attempts to rename each pool slot into that private path in
order; `ENOENT` means another creator won that slot, so it tries the next one. If every slot is
gone, it clones the possibly stale base into the private path. Git work and `hooks.prepare` happen
there. Only the final state mutation, after repeating all conflict checks and checking the final
path, renames the attempt to `<slug>` and registers it. A loser trashes only its private attempt,
never the canonical destination. Claims emit `prepared-copy-claimed` immediately for refill.
`hotPoolSize: 0` disables prepared copies. The base is never refreshed on the interactive path.

Prepared copies carry `.git/swarm-hot.json` with
`{fetchedAt, defaultBranch, sha, prepareFingerprint}`; the fingerprint is SHA-256 over the current
ordered `hooks.prepare` command list. A marker
younger than `config.hotFreshnessMs` suppresses the network fetch only when its branch and SHA
still match the local remote ref and its hook fingerprint matches; missing, stale, invalid,
unverifiable, or differently prepared markers refresh. Refresh removes the marker before any
fetch/reset/clean/hook work and writes it only after preparation completes, so cancellation or
failure leaves the slot stale. A fingerprint mismatch discards the slot and rebuilds it via its
`.staging` path from the pristine base, removing ignored artifacts from changed or deleted hooks.
Other refreshes rerun `hooks.prepare` after a reset before restoring the marker. After
either choice, creation compares `HEAD` with `origin/<default>` and checks porcelain status,
skipping checkout/reset/clean only when both revisions match and the tree is clean. Stale paths
explicitly fetch remote-tracking refspecs. A named branch always attempts a combined default +
requested-branch fetch, including an explicitly selected non-default `origin/<base>` refspec, then
relists refs. If the combined fetch fails it fetches every required base ref separately and treats
only the requested branch as optional; an unavailable selected base fails creation instead of using
a stale cached ref. Every PR creation, including same-repository PRs, fetches
`+refs/pull/<n>/head:refs/heads/<local-branch>` before checkout. Every reported operation step
emits a duration to both the operation log and `logs/swarm.log`.

Default-branch resolution trusts `refs/remotes/origin/HEAD` only when its target exists among known
remote branches (or passes `show-ref`). A dangling target triggers `git remote set-head origin
--auto`, a re-read, and then the existing hint/main/master/first-remote fallback chain.

Each replenish fills only the lowest empty slot. It refreshes the base clone outside the state
mutation lock, copies into the matching staging path, runs `hooks.prepare` there, writes the marker,
and publishes with a rename only after all preparation finishes. Hook failures are warnings and do
not prevent publication. Concurrent rebuilds for one repo share an in-memory promise. Startup asks
for enough replenishments to fill each configured pool while a two-worker semaphore limits active
repositories; clone promotion and creation also schedule replenishment. Reserved `.hot*` directory
names are excluded from normal worktree directory listings. Replenishment/startup enumerates the
repo worktree root and removes numbered slots beyond the configured size; repository deletion uses
the same discovery rule to remove `.hot`, `.hot.<n>`, and their `.staging` variants regardless of
the current pool size. Repository deletion first marks the repo as deleting, rejects new
prepare/refresh requests, aborts and awaits existing work, then discovers and removes every slot
while holding the repo mutex. Preparation rechecks both the deleting flag and repository
registration immediately before publishing staging to a slot.

One in-process async mutex per repository serializes slot claims, preparation, each prepared-slot
refresh, base refresh/reset, and clone-from-base staging. Post-claim Git work in a private attempt
does not hold it. This mutex intentionally does not coordinate separate swarm OS processes;
cross-process exclusion is limited to the final state lock and destination conflict checks.

`refreshPreparedCopy(repoId, {signal, skipIfFresh})` full-fetches, resets, and rewrites the marker
for every existing configured slot, sequentially; when no slot exists it refreshes the base.
`skipIfFresh` returns without Git I/O only when every existing slot marker is younger than
`hotFreshnessMs` and fingerprints match. A skip-if-fresh caller joins any active refresh; a forced
caller arriving behind a skip-mode run queues one forced run immediately after it. Shared work owns
its AbortController: aborting a caller detaches only that caller and cancels the shared operation
only after the last interested caller aborts. `awaitPendingRefresh(repoId)` exposes the whole
in-flight boundary. The controller gives refresh/preparation work a lifecycle signal and aborts it
from `dispose()`. The production controller runs a sequential periodic refresh every
`hotRefreshIntervalMs`; `0` disables it and tests opt in.

Creation registers the worktree before post-create work. The controller then starts
`runPostCreateHooks(worktreeId, onEvent)` as `Post-create hooks · <slug>`, using a distinct operation
target so the registered worktree remains openable. One detached `sh` runner owns the complete
ordered sequence with stdin ignored and stdout/stderr appended to `logs/swarm.log`; it is unrefed so
it cannot keep an exited TUI alive, while a live TUI still tracks its exit. The runner writes
per-hook start/end/exit/duration records. The live TUI
parses those records into command, step, duration, and warning lines. The runner continues after a
hook fails, preserving warning semantics, and failures never undo registration.

All service state changes go through `src/services/stateMutation.ts`. It delegates to the
state adapter's transactional `mutate` extension when available; that adapter holds an
exclusive `state.json.lock` across the complete load-modify-save sequence, serializing both
in-process and cross-process writers, and writes the result atomically. Test ports without
`mutate` use a per-port in-process promise chain. Worktree creation performs preflight, copy,
git operations, and prepare hooks outside that lock. The final transaction re-runs the shared slug,
session, and registered-path conflict checks against fresh state, updates the default branch,
and appends the record. Immediately before attempt-to-destination rename, creation writes
`.git/swarm-creating.json` containing id, repo, branch, base ref, and timestamp; it removes the marker
only after the state write commits. Controller startup scans registered repository roots before
hydration: complete intents whose checked-out branch matches are registered, while invalid or
mismatched intents move through trash. A destination carrying an unregistered intent is reclaimable
during create preflight. Normal state-write failures still roll the published path back.

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
  | { kind: "create-worktree"; repoId: RepoId; generation: number; branches: string[]; fetching: boolean }
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
  | { type: "updateCreateWorktreeBranches"; repoId: RepoId; generation: number; branches?: string[]; fetching: boolean }
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
  refreshPreparedCopy(repoId: RepoId): void;              // fire-and-forget dialog pre-fetch
  deleteSelected(): Promise<void>;                      // opens confirm dialog with impact summary
  cloneRepo(remote: RemoteRepo): Promise<void>; searchRemote(q: string, signal?: AbortSignal): Promise<RemoteRepo[]>;
  assignRepo(repoId: RepoId, contextId: ContextId): Promise<void>;
  saveContext(input: { id?: ContextId; name: string; owners: string[] }): Promise<void>; deleteContext(id: ContextId): Promise<void>;
  saveConfig(patch: Partial<Config>): Promise<void>; getConfig(): Config;
  yankPath(): Promise<void>;
  update(): Promise<void>;                              // clean main → pull, install, build → request exit 75
  dispose(): void;
}
export interface KeyEvent { name: string; ctrl: boolean; shift: boolean; meta: boolean; sequence: string }
export type Command = "down"|"up"|"top"|"bottom"|"halfDown"|"halfUp"|"left"|"right"|"open"|"openKeep"|"new"|"newContext"|"delete"|"deleteContext"|"sleep"|"kill"|"move"|"refresh"|"update"|"filter"|"palette"|"settings"|"help"|"yank"|"quit"|"nextContext"|"prevContext"|`context:${number}`|"clearFilter"|"none";
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
| `U` | update swarm from a clean `main`, rebuild, and restart |
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

The `new` command opens the worktree dialog immediately with locally known base refs, then calls
`Controller.refreshPreparedCopy`. While the forced refresh runs, the picker displays `fetching…`.
Completion re-lists remote branches and dispatches `updateCreateWorktreeBranches`; the reducer
applies it only if the same repo and dialog-open generation are still active, so closing and
reopening the same repository cannot accept an older completion.

## 10. Integration notes

- 2026-09-03: Round-2 hardening added `.git/swarm-creating.json` publish intents plus startup
  reconciliation; invalidates hot markers before destructive refresh and rebuilds fingerprint
  changes from the pristine base; coordinates repository deletion with preparation/refresh aborts
  under the repo mutex; cleans clone-first attempts on partial-copy errors; runs all post-create
  hooks in one detached record-producing runner; validates `origin/HEAD`; explicitly fetches selected
  non-default base refs; and keys dialog prefetch completions by open generation. Filesystem-backed
  cross-instance tests now cover state-lock create races, single-slot claim/fallback, and rollback
  after a post-publish state-write failure.
- 2026-09-03: Review hardening moved creation into unique `.creating-<uuid>` attempts and made
  final publish part of locked registration; added per-repo mutexes and atomic rename-as-claim pool
  selection; explicit remote-tracking branch and all-PR head fetches; prepare-hook fingerprints and
  reruns after reset/config changes; lifecycle cancellation plus `Shell.runDetachedLogged`; dynamic
  `.hot*` discovery/removal; and mode-aware refresh dedupe with per-caller abort detachment.
  `FilesPort.listDirs` gained `includeReserved`, `WorktreeService.prepareHotCopy` gained a signal,
  and cross-process mutexing remains explicitly out of scope.
- 2026-09-03: Phase B added `Config.hotPoolSize` (default 1) and
  `Config.hotRefreshIntervalMs` (default 300000), numbered `.hot.<n>` slots, lowest-slot
  consume/replenish ordering, two-repo startup preparation, and sequential freshness-aware
  periodic refresh. `hotPoolSize: 0` and refresh interval `0` disable their respective features.
  `hotCopyPath`/`hotCopyStagingPath` gained an optional slot argument;
  `refreshPreparedCopy` gained `skipIfFresh`; and `OpEvent` gained `prepared-copy-claimed` for
  immediate controller replenishment.
- 2026-09-03: Phase B split repo hooks into `hooks.prepare` and `hooks.postCreate`.
  `WorktreeService.runPostCreateHooks` runs the latter after registration through a separate
  controller operation, leaving session open available. The create dialog now opens before a
  forced prepared-copy refresh, shows `fetching…`, and safely merges newly listed remote branches.
- 2026-09-03: Phase A moved worktree copy/git/hooks off the state lock, changed missing-pool
  fallback to clone-then-refresh-destination, and added timed operation-log/file-log steps.
  Prepared copies now store `.git/swarm-hot.json`; `Config.hotFreshnessMs` defaults to 60000.
  `WorktreeService` gained deduplicated `refreshPreparedCopy` and `awaitPendingRefresh`, while
  `GitPort` gained narrow `fetchRefs`, abortable refresh methods, and `revision`.
- 2026-09-03: worktree creation gained a per-repository single-slot hot-copy pool. Complete
  copies are staged under `.hot.staging`, atomically published as `.hot`, consumed by rename,
  refreshed in their destination, and rebuilt by controller-managed background operations.
  Missing or failed pools use the clone-first fallback described above.
- 2026-09-03: `swarm agent <claude|opencode>` creates or reuses a persistent tmux session rooted
  at `config.reposDir`; `prefix+a` / `prefix+A` open those sessions in popups and `C-q` detaches
  their nested client so the popup can close without stopping the agent.
- 2026-09-02: PR cache reads and network refreshes are now separate `GithubPort` operations.
  `PrService` emits validated cached slices before refresh, retains them with a short error on
  refresh failure, and owns one four-call limiter plus repo/tab generations and abort signals
  across every overlapping load. PR schemas accept only exact numbered `github.com` pull URLs,
  with `ProcessPort.openUrl` repeating the HTTPS/host allowlist; branch validation now mirrors
  `git check-ref-format --branch`. Successful context switches background-load both PR tabs.
- 2026-09-02: the pull request screen got its rendering and input wiring. `buildScreen` now
  branches on `AppState.screen`: `prs` replaces the two panes with one full-width body (tab
  header, PR list, per-repo error rows, detail pane) while the frame, context tabs and footer
  stay put, so `ScreenContext` gained a `prScroll` offset alongside the two existing ones and
  `worktreeColumns(rightWidth, badged?)` gained an optional PR-badge column that only exists
  while a visible worktree row actually has a pull request. The footer reads its hints from
  `prHints` on that screen, the palette lists only commands whose `screens` include the current
  one, and `src/app/selectors.ts` exports `prScopeRepoIds` (previously private) so the UI can
  label the scope and its freshness without re-deriving the scope rule.
- 2026-09-02: pull requests became a first-class non-persisted app feature. Core now defines
  validated `PullRequest`, `PrRepoSlice`, `PrTab`, check/review/state types and pure PR/worktree
  matching helpers; `Config.github.prTtlSeconds` defaults to 90.
  `GithubPort.readCachedPullRequests` returns validated per-repo/per-tab data from
  `cache/github/prs/<owner>/<name>/<tab>.json`, while `listPullRequests` refreshes it;
  `GitPort.fetchPullHead` safely fetches fork PR
  refs; and `ProcessPort.openUrl` launches the platform browser with detached argv.
  `PrService.load` streams isolated per-repo slices at concurrency four, while
  `WorktreeService.create` accepts `source: {kind:"pull", number}` and persists fork worktrees
  with `baseRef: pull/<number>/head`. `AppState` now carries `screen`, PR tab/cursor/filter/scope
  and slice maps; its reducer, selectors, screen-aware keymap/command metadata, and `Controller`
  expose PR navigation, refresh, contextual open/create, browser, copy, and back operations.
- 2026-09-02: repository cloning became a persisted detached background job. `Shell.spawnDetached`
  now returns a pid and can redirect output to a log; `GitPort` exposes `cloneDetached`; `State`
  and `AppState` include clone jobs; and `RepoService.reconcileClones` promotes or fails them on
  startup, refresh, or the controller's active-clone timer. Existing version-1 state remains
  compatible because `clones` defaults to an empty array. State mutations also reclaim lock files
  whose recorded process is dead or invalid, while protecting live and newly-created empty locks;
  interactive lock acquisition times out after three seconds.
