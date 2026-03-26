# Implementation Plan: Rewrite Swarm TUI with OpenTUI (TypeScript + Bun)

Generated: 2026-03-25

---

## Summary

**Swarm** is a Git worktree + tmux session manager currently written in Go (Bubble Tea TUI, Cobra CLI, Viper config). The goal is to **rewrite the entire application in TypeScript + Bun** using **OpenTUI React** for the terminal UI, following **OOP and Command Pattern** conventions, with a strict **separation of concern** between the TUI layer and the business logic/service layer.

The current Go codebase is approximately 3,950 lines across `internal/` (config, git, repo, worktree, tmux, state, safety, status, prompt, tui) and `cmd/` (CLI commands). The new TypeScript codebase will live in a `tui/` directory at the project root and will be a standalone Bun project.

**Why**: Move to a TypeScript/Bun stack for faster iteration, leverage OpenTUI's React reconciler for a richer TUI experience, and improve maintainability with OOP service classes and the Command pattern.

---

## Prerequisites

### Environment

| Requirement | Version | Install |
|-------------|---------|---------|
| Bun | >= 1.0 | `curl -fsSL https://bun.sh/install \| bash` |
| Node.js | >= 18 (for React types) | Already available or via `nvm` |
| tmux | >= 3.0 | `brew install tmux` |
| git | >= 2.30 | Already available |

### Dependencies to Install

```bash
# Core
bun install @opentui/core @opentui/react react

# Dev
bun install -d @types/bun @types/react typescript

# YAML parsing (for config)
bun install yaml

# File locking (for state persistence)
bun install proper-lockfile
bun install -d @types/proper-lockfile
```

### Project Structure Knowledge

The developer must understand:
1. The existing Go architecture (described fully in this plan)
2. OpenTUI React reconciler API (`@opentui/react`)
3. Bun's `Bun.spawnSync()` / `Bun.spawn()` for shell commands
4. React patterns: `useReducer`, `useContext`, `useKeyboard` hook

### Coding Conventions

- **OOP for services**: All business logic in classes with clear interfaces
- **Command Pattern**: User actions encapsulated as Command objects that execute through a service
- **Separation of concerns**: UI components never call `git`, `tmux`, or filesystem directly -- always through service classes
- **Naming**: PascalCase for classes/components/types, camelCase for methods/variables, kebab-case for filenames
- **File organization**: One class per file, tests colocated as `*.test.ts`/`*.test.tsx`
- **Error handling**: Services return `Result<T, Error>` style or throw typed errors caught at the command level
- **No default exports**: Use named exports everywhere

---

## Affected Files & Directories

### New Directory Structure (to create)

```
tui/
  package.json
  tsconfig.json
  biome.json                        # Linter + formatter config
  src/
    index.tsx                        # Entry point
    App.tsx                          # Root component

    # --- Service Layer (OOP) ---
    services/
      GitService.ts                  # Git CLI wrapper (replaces internal/git/)
      TmuxService.ts                 # Tmux CLI wrapper (replaces internal/tmux/)
      ConfigService.ts               # Config loading (replaces internal/config/)
      StateService.ts                # State persistence (replaces internal/state/)
      RepoService.ts                 # Repository discovery (replaces internal/repo/)
      WorktreeService.ts             # Worktree CRUD (replaces internal/worktree/)
      SafetyService.ts               # Safety checks (replaces internal/safety/)
      StatusService.ts               # Status computation (replaces internal/status/)
      ClipboardService.ts            # Clipboard via OSC52

    # --- Types ---
    types/
      config.ts                      # Config types
      git.ts                         # Git types (WorktreeInfo, StatusResult, Commit, etc.)
      repo.ts                        # Repo types
      worktree.ts                    # Worktree types
      tmux.ts                        # Tmux types (Session, Layout, Window, Pane)
      state.ts                       # State types (State, RepoState, WorktreeState)
      safety.ts                      # Safety types (CheckResult, Blocker, Warning)
      status.ts                      # Status types (Status, Badge)

    # --- Command Pattern ---
    commands/
      Command.ts                     # Abstract Command interface
      CreateWorktreeCommand.ts       # Create worktree
      OpenWorktreeCommand.ts         # Open worktree in tmux
      DeleteWorktreeCommand.ts       # Delete worktree (with safety check)
      RefreshCommand.ts              # Refresh worktree list
      PruneOrphansCommand.ts         # Prune orphaned worktrees
      CopyToClipboardCommand.ts      # Copy text to clipboard
      CleanOrphanCommand.ts          # Clean single orphan

    # --- Utilities ---
    utils/
      slug.ts                        # Branch-to-slug conversion
      shell.ts                       # Shell execution helpers
      result.ts                      # Result type for error handling
      git-parser.ts                  # Git output parsers

    # --- UI Components (OpenTUI React) ---
    components/
      RepoList.tsx                   # Left panel: repository list
      WorktreeList.tsx               # Middle panel: worktree list with badges
      DetailView.tsx                 # Right panel: worktree details
      StatusBar.tsx                  # Bottom bar: shortcuts + messages
      Panel.tsx                      # Reusable bordered panel
      Dialog.tsx                     # Modal confirmation dialog
      InputDialog.tsx                # Modal text input (branch name)
      HelpDialog.tsx                 # Help overlay
      Badge.tsx                      # Status badge rendering

    # --- State Management (React Context + Reducer) ---
    state/
      AppContext.tsx                  # React context provider
      appReducer.ts                  # Reducer logic
      actions.ts                     # Action type definitions

    # --- Hooks ---
    hooks/
      useKeyboardShortcuts.ts        # Global keyboard handler
      useAppActions.ts               # Hook that returns bound action dispatchers
      useServices.ts                 # Hook to access services from context

    # --- Tests ---
    __tests__/
      services/
        GitService.test.ts
        WorktreeService.test.ts
        StateService.test.ts
        ConfigService.test.ts
        StatusService.test.ts
        SafetyService.test.ts
      utils/
        slug.test.ts
        git-parser.test.ts
      components/
        RepoList.test.tsx
        WorktreeList.test.tsx
        Dialog.test.tsx
        App.test.tsx
```

### Existing Files (reference only, not modified)

All files under `internal/` and `cmd/` are the Go source that we are porting FROM. They remain untouched.

### Scope

**IN SCOPE:**
- Full TUI application rewrite (3-panel layout with dialogs)
- All service layer classes (git, tmux, config, state, repo, worktree, safety, status)
- Command pattern for all user actions
- Keyboard shortcuts matching current behavior
- State persistence (`.swarm-state.json` compatibility)
- Config file reading (`~/.config/swarm/config.yaml`)
- Clipboard support via OpenTUI OSC52

**OUT OF SCOPE:**
- CLI subcommands (`swarm create`, `swarm list`, etc.) -- TUI only for now
- fzf integration (`PreferFzf` config option)
- Custom tmux layout loading from JSON/shell scripts (Phase 2)
- Go code modification or removal
- CI/CD pipeline setup

---

## Task Breakdown

### Phase 1: Project Scaffolding & Types (Estimated: 1 session)

#### Task 1.1: Initialize Bun project
- **Complexity**: Low
- **Dependencies**: None
- **Files**: `tui/package.json`, `tui/tsconfig.json`, `tui/biome.json`
- **Acceptance criteria**: `bun install` succeeds, `bun run src/index.tsx` renders "Hello from Swarm" in terminal

#### Task 1.2: Define all TypeScript types
- **Complexity**: Low
- **Dependencies**: Task 1.1
- **Files**: All files in `tui/src/types/`
- **Acceptance criteria**: All types from Go structs have TypeScript equivalents, `tsc --noEmit` passes

#### Task 1.3: Create Result type and shell utilities
- **Complexity**: Low
- **Dependencies**: Task 1.1
- **Files**: `tui/src/utils/result.ts`, `tui/src/utils/shell.ts`
- **Acceptance criteria**: `shell.exec("echo hello")` returns `{ stdout: "hello\n", ... }`, Result type works for success/error

---

### Phase 2: Service Layer (Estimated: 3-4 sessions)

#### Task 2.1: ConfigService
- **Complexity**: Low
- **Dependencies**: Task 1.2
- **Files**: `tui/src/services/ConfigService.ts`
- **Acceptance criteria**: Reads `~/.config/swarm/config.yaml`, falls back to defaults, respects env vars with `SWARM_` prefix
- **Port from**: `internal/config/config.go`, `internal/config/loader.go`, `internal/config/validate.go`

#### Task 2.2: StateService
- **Complexity**: Medium
- **Dependencies**: Task 1.2, Task 1.3
- **Files**: `tui/src/services/StateService.ts`
- **Acceptance criteria**: Reads/writes `.swarm-state.json` with file locking, backward-compatible with Go state format
- **Port from**: `internal/state/store.go`, `internal/state/types.go`

#### Task 2.3: Slug utility
- **Complexity**: Low
- **Dependencies**: Task 1.2
- **Files**: `tui/src/utils/slug.ts`
- **Acceptance criteria**: `generateSlug("feature/auth-flow")` returns `"feature_auth-flow"`, handles collisions with `_2`, `_3` suffix
- **Port from**: `internal/worktree/slug.go`

#### Task 2.4: Git parser utility
- **Complexity**: Medium
- **Dependencies**: Task 1.2
- **Files**: `tui/src/utils/git-parser.ts`
- **Acceptance criteria**: Parses `git worktree list --porcelain` output, `git status --porcelain` output, and pipe-delimited commit format
- **Port from**: `internal/git/parser.go`

#### Task 2.5: GitService
- **Complexity**: Medium
- **Dependencies**: Task 1.3, Task 2.4
- **Files**: `tui/src/services/GitService.ts`
- **Acceptance criteria**: All git operations work: worktree list/add/remove, fetch, status, default branch detection, branch info
- **Port from**: `internal/git/client.go`, `internal/git/branch.go`, `internal/git/safety.go`

#### Task 2.6: RepoService
- **Complexity**: Low
- **Dependencies**: Task 2.1, Task 2.5
- **Files**: `tui/src/services/RepoService.ts`
- **Acceptance criteria**: Scans `ai_working/` directory, finds git repos, skips `__wt__` directories
- **Port from**: `internal/repo/discovery.go`

#### Task 2.7: TmuxService
- **Complexity**: Medium
- **Dependencies**: Task 1.3
- **Files**: `tui/src/services/TmuxService.ts`
- **Acceptance criteria**: Create/attach/kill sessions, list sessions with details, apply default layout
- **Port from**: `internal/tmux/client.go`, `internal/tmux/layout.go`

#### Task 2.8: WorktreeService
- **Complexity**: Medium
- **Dependencies**: Task 2.2, Task 2.3, Task 2.5, Task 2.6
- **Files**: `tui/src/services/WorktreeService.ts`
- **Acceptance criteria**: Create, list, remove worktrees. Merges git worktree list with state store data. Handles orphan detection.
- **Port from**: `internal/worktree/manager.go`, `internal/worktree/orphan.go`

#### Task 2.9: SafetyService
- **Complexity**: Medium
- **Dependencies**: Task 2.5
- **Files**: `tui/src/services/SafetyService.ts`
- **Acceptance criteria**: Returns CheckResult with blockers and warnings. Checks uncommitted changes, unpushed commits, merged status.
- **Port from**: `internal/safety/checker.go`, `internal/safety/branch.go`, `internal/safety/safety.go`

#### Task 2.10: StatusService
- **Complexity**: Medium
- **Dependencies**: Task 2.5, Task 2.9
- **Files**: `tui/src/services/StatusService.ts`
- **Acceptance criteria**: Computes status with TTL caching, returns badges, supports parallel computation
- **Port from**: `internal/status/computer.go`, `internal/status/badge.go`, `internal/status/status.go`

#### Task 2.11: ClipboardService
- **Complexity**: Low
- **Dependencies**: Task 1.1
- **Files**: `tui/src/services/ClipboardService.ts`
- **Acceptance criteria**: Copies text via `renderer.copyToClipboardOSC52()`

---

### Phase 3: Command Pattern (Estimated: 1-2 sessions)

#### Task 3.1: Command interface and base
- **Complexity**: Low
- **Dependencies**: Phase 2
- **Files**: `tui/src/commands/Command.ts`
- **Acceptance criteria**: Abstract `Command` interface defined with `execute()` method returning `Promise<CommandResult>`

#### Task 3.2: Implement all commands
- **Complexity**: Medium
- **Dependencies**: Task 3.1
- **Files**: All files in `tui/src/commands/`
- **Acceptance criteria**: Each command encapsulates one user action, uses services, returns result with status message or error
- **Port from**: `internal/tui/actions.go` (the logic in action handlers becomes command bodies)

---

### Phase 4: State Management (Estimated: 1 session)

#### Task 4.1: Define reducer and actions
- **Complexity**: Medium
- **Dependencies**: Task 1.2
- **Files**: `tui/src/state/appReducer.ts`, `tui/src/state/actions.ts`
- **Acceptance criteria**: All state transitions from Go Model are covered (repo/worktree selection, input mode, dialog state, error/status messages)
- **Port from**: `internal/tui/model.go` (state shape), `internal/tui/update.go` (transitions)

#### Task 4.2: Create React context provider
- **Complexity**: Medium
- **Dependencies**: Task 4.1, Phase 2 services
- **Files**: `tui/src/state/AppContext.tsx`
- **Acceptance criteria**: Services and state accessible via context, dispatch available to all components

#### Task 4.3: Create hooks for state access
- **Complexity**: Low
- **Dependencies**: Task 4.2
- **Files**: `tui/src/hooks/useServices.ts`, `tui/src/hooks/useAppActions.ts`
- **Acceptance criteria**: `useServices()` returns all service instances, `useAppActions()` returns bound action dispatchers

---

### Phase 5: UI Components (Estimated: 3-4 sessions)

#### Task 5.1: Entry point and App shell
- **Complexity**: Low
- **Dependencies**: Task 4.2
- **Files**: `tui/src/index.tsx`, `tui/src/App.tsx`
- **Acceptance criteria**: App renders 3-column layout with placeholder panels
- **Port from**: `cmd/tui.go`, `internal/tui/model.go:Init()`

#### Task 5.2: Panel component
- **Complexity**: Low
- **Dependencies**: Task 5.1
- **Files**: `tui/src/components/Panel.tsx`
- **Acceptance criteria**: Renders bordered box with title, highlights when focused (blue `#4455FF` vs gray `#555555`)
- **Port from**: `internal/tui/view.go:renderPanel()`

#### Task 5.3: RepoList component
- **Complexity**: Medium
- **Dependencies**: Task 5.2
- **Files**: `tui/src/components/RepoList.tsx`
- **Acceptance criteria**: Renders scrollable list of repos, highlights selected, navigates with j/k/up/down, triggers worktree load on selection change
- **Port from**: `internal/tui/items.go:repoItem`, `internal/tui/view.go`, `internal/tui/update.go:checkRepoSelectionChanged()`

#### Task 5.4: WorktreeList component
- **Complexity**: Medium
- **Dependencies**: Task 5.2
- **Files**: `tui/src/components/WorktreeList.tsx`, `tui/src/components/Badge.tsx`
- **Acceptance criteria**: Renders worktree list with status badges, `[GONE]` for orphaned, updates detail on selection change
- **Port from**: `internal/tui/items.go:worktreeItem`, `internal/status/badge.go`

#### Task 5.5: DetailView component
- **Complexity**: Low
- **Dependencies**: Task 5.2
- **Files**: `tui/src/components/DetailView.tsx`
- **Acceptance criteria**: Shows branch, slug, path, repo, status badges, created/opened dates
- **Port from**: `internal/tui/view.go:renderDetail()`

#### Task 5.6: StatusBar component
- **Complexity**: Low
- **Dependencies**: Task 5.1
- **Files**: `tui/src/components/StatusBar.tsx`
- **Acceptance criteria**: Shows context-sensitive key hints, error messages (red), status messages (green)
- **Port from**: `internal/tui/view.go:renderStatusBar()`

#### Task 5.7: Dialog component
- **Complexity**: Medium
- **Dependencies**: Task 5.1
- **Files**: `tui/src/components/Dialog.tsx`
- **Acceptance criteria**: Centered modal with title, message, buttons (left/right navigation), Enter to confirm, Esc to cancel
- **Port from**: `internal/tui/dialog.go`

#### Task 5.8: InputDialog component
- **Complexity**: Medium
- **Dependencies**: Task 5.1
- **Files**: `tui/src/components/InputDialog.tsx`
- **Acceptance criteria**: Centered modal with title, text input, placeholder, Enter to submit, Esc to cancel
- **Port from**: `internal/tui/view.go:renderInputView()`

#### Task 5.9: HelpDialog component
- **Complexity**: Low
- **Dependencies**: Task 5.7
- **Files**: `tui/src/components/HelpDialog.tsx`
- **Acceptance criteria**: Shows keyboard shortcut reference, single "OK" button
- **Port from**: `internal/tui/actions.go:handleHelp()`

---

### Phase 6: Keyboard & Wiring (Estimated: 1-2 sessions)

#### Task 6.1: Global keyboard handler
- **Complexity**: High
- **Dependencies**: Phase 5 components, Phase 3 commands
- **Files**: `tui/src/hooks/useKeyboardShortcuts.ts`
- **Acceptance criteria**: All keyboard shortcuts from Go TUI work identically. Respects input mode and dialog mode priorities.
- **Port from**: `internal/tui/update.go:handleKeyMsg()`, `updateInput()`, `updateDialog()`

#### Task 6.2: Wire commands to UI
- **Complexity**: High
- **Dependencies**: Task 6.1, Phase 3 commands
- **Files**: Updates to `App.tsx` and all component files
- **Acceptance criteria**: All actions (create, open, delete, refresh, prune, copy, help) execute through commands and update state

---

### Phase 7: Testing (Estimated: 2-3 sessions)

#### Task 7.1: Service unit tests
- **Complexity**: Medium
- **Dependencies**: Phase 2
- **Files**: `tui/src/__tests__/services/*.test.ts`
- **Acceptance criteria**: All services have tests for core operations, mocking shell commands

#### Task 7.2: Utility unit tests
- **Complexity**: Low
- **Dependencies**: Task 2.3, Task 2.4
- **Files**: `tui/src/__tests__/utils/*.test.ts`
- **Acceptance criteria**: Slug generation and git parser fully covered

#### Task 7.3: Component snapshot tests
- **Complexity**: Medium
- **Dependencies**: Phase 5
- **Files**: `tui/src/__tests__/components/*.test.tsx`
- **Acceptance criteria**: Key components render correctly in test renderer

#### Task 7.4: Integration test
- **Complexity**: High
- **Dependencies**: Phase 6
- **Files**: `tui/src/__tests__/components/App.test.tsx`
- **Acceptance criteria**: Full app renders, simulated keyboard input navigates correctly

---

## Implementation Details

### Task 1.1: Initialize Bun Project

Create `tui/package.json`:
```json
{
  "name": "swarm-tui",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "start": "bun run src/index.tsx",
    "dev": "bun --watch run src/index.tsx",
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "lint": "bunx biome check .",
    "lint:fix": "bunx biome check --write .",
    "build": "bun build src/index.tsx --outdir=dist --target=bun"
  },
  "dependencies": {
    "@opentui/core": "latest",
    "@opentui/react": "latest",
    "react": ">=19.0.0",
    "yaml": "^2.0.0",
    "proper-lockfile": "^4.1.0"
  },
  "devDependencies": {
    "@biomejs/biome": "latest",
    "@types/bun": "latest",
    "@types/react": ">=19.0.0",
    "@types/proper-lockfile": "latest",
    "typescript": "latest"
  }
}
```

Create `tui/tsconfig.json`:
```json
{
  "compilerOptions": {
    "lib": ["ESNext", "DOM"],
    "target": "ESNext",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "jsx": "react-jsx",
    "jsxImportSource": "@opentui/react",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["bun-types"],
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "esModuleInterop": true,
    "forceConsistentCasingInImports": true
  },
  "include": ["src/**/*"]
}
```

### Task 1.2: Define TypeScript Types

Port every Go struct to TypeScript. Key mapping:

**`tui/src/types/git.ts`:**
```typescript
export interface WorktreeInfo {
  path: string
  branch: string
  commit: string
  detached: boolean
}

export interface StatusResult {
  modified: string[]
  added: string[]
  deleted: string[]
  untracked: string[]
}

export interface Commit {
  hash: string
  message: string
  author: string
  date: Date
}

export interface AddOptions {
  path: string
  branch: string
  baseBranch: string
  newBranch: boolean
}

export interface BranchInfo {
  name: string
  exists: boolean
  hasCommits: boolean
  commitCount: number
  isMerged: boolean
  upstream: string
  lastCommit: Commit | null
}
```

**`tui/src/types/worktree.ts`:**
```typescript
export interface Worktree {
  slug: string
  branch: string
  path: string
  repoName: string
  createdAt: Date
  lastOpenedAt: Date
  tmuxSession: string
  isOrphaned: boolean
}

export interface CreateOptions {
  branch: string
  baseBranch: string
  newBranch: boolean
}

export interface OrphanedWorktree {
  slug: string
  branch: string
  path: string
  reason: string
  createdAt: Date
}
```

**`tui/src/types/config.ts`:**
```typescript
export type WorktreePattern = "patternA" | "patternB" | "patternC"

export interface Config {
  aiWorkingDir: string
  defaultBaseBranch: string
  worktreePattern: WorktreePattern
  createSessionOnCreate: boolean
  tmuxLayoutScript: string
  statusCacheTTL: number // milliseconds
  preferFzf: boolean
  autoPruneOnRemove: boolean
}
```

Follow the same pattern for `state.ts`, `tmux.ts`, `safety.ts`, `status.ts`, `repo.ts`.

### Task 1.3: Shell Utility

**`tui/src/utils/shell.ts`:**
```typescript
export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
  success: boolean
}

export function execSync(command: string, args: string[], cwd?: string): ShellResult {
  const proc = Bun.spawnSync([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString().trim(),
    exitCode: proc.exitCode,
    success: proc.exitCode === 0,
  }
}

export async function exec(command: string, args: string[], cwd?: string): Promise<ShellResult> {
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode,
    success: exitCode === 0,
  }
}
```

**`tui/src/utils/result.ts`:**
```typescript
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E }

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}
```

### Task 2.1: ConfigService

**`tui/src/services/ConfigService.ts`** -- follows the pattern from `internal/config/`:

```typescript
import { parse as parseYaml } from "yaml"
import { type Config, type WorktreePattern } from "../types/config"

const VALID_PATTERNS: WorktreePattern[] = ["patternA", "patternB", "patternC"]

export class ConfigService {
  private config: Config | null = null

  async load(): Promise<Config> {
    if (this.config) return this.config

    const defaults = this.getDefaults()
    const fileConfig = await this.loadFromFile()
    const envConfig = this.loadFromEnv()

    // Merge: defaults < file < env (highest priority)
    this.config = { ...defaults, ...fileConfig, ...envConfig }
    this.validate(this.config)
    return this.config
  }

  private getDefaults(): Config {
    return {
      aiWorkingDir: process.env.AI_WORKING_DIR ??
        `${process.env.HOME}/amplifier/ai_working`,
      defaultBaseBranch: "main",
      worktreePattern: "patternA",
      createSessionOnCreate: true,
      tmuxLayoutScript: "",
      statusCacheTTL: 30_000,
      preferFzf: false,
      autoPruneOnRemove: true,
    }
  }

  private async loadFromFile(): Promise<Partial<Config>> {
    const configDir = process.env.XDG_CONFIG_HOME ??
      `${process.env.HOME}/.config`
    const configPath = `${configDir}/swarm/config.yaml`

    try {
      const file = Bun.file(configPath)
      if (!(await file.exists())) return {}
      const content = await file.text()
      return parseYaml(content) ?? {}
    } catch {
      return {}
    }
  }

  private loadFromEnv(): Partial<Config> {
    const env: Partial<Config> = {}
    if (process.env.SWARM_DEFAULT_BASE_BRANCH)
      env.defaultBaseBranch = process.env.SWARM_DEFAULT_BASE_BRANCH
    if (process.env.SWARM_WORKTREE_PATTERN)
      env.worktreePattern = process.env.SWARM_WORKTREE_PATTERN as WorktreePattern
    // ... etc for all env vars
    return env
  }

  private validate(config: Config): void {
    if (!VALID_PATTERNS.includes(config.worktreePattern)) {
      throw new Error(`Invalid worktree pattern: ${config.worktreePattern}`)
    }
  }
}
```

### Task 2.5: GitService

**`tui/src/services/GitService.ts`** -- the core service wrapping all git CLI calls:

```typescript
import { execSync } from "../utils/shell"
import { parseWorktreeList, parseStatus, parseCommits } from "../utils/git-parser"
import type { WorktreeInfo, StatusResult, BranchInfo, Commit, AddOptions } from "../types/git"

export class GitService {
  worktreeList(repoPath: string): WorktreeInfo[] {
    const result = execSync("git", ["-C", repoPath, "worktree", "list", "--porcelain"])
    if (!result.success) throw new Error(`git worktree list failed: ${result.stderr}`)
    return parseWorktreeList(result.stdout)
  }

  worktreeAdd(repoPath: string, opts: AddOptions): void {
    const args = ["-C", repoPath, "worktree", "add"]
    if (opts.newBranch) {
      args.push("-b", opts.branch, opts.path)
      if (opts.baseBranch) args.push(opts.baseBranch)
    } else {
      args.push(opts.path, opts.branch)
    }
    const result = execSync("git", args)
    if (!result.success) throw new Error(`git worktree add failed: ${result.stderr}`)
  }

  worktreeRemove(repoPath: string, worktreePath: string): void {
    const result = execSync("git", ["-C", repoPath, "worktree", "remove", worktreePath])
    if (!result.success) throw new Error(`git worktree remove failed: ${result.stderr}`)
  }

  // ... all other methods following same pattern
  // Port: fetchAll, status, defaultBranch, branchExists, getBranchInfo,
  //       isMerged, unpushedCommits, deleteBranch
}
```

### Task 2.7: TmuxService

**`tui/src/services/TmuxService.ts`:**

```typescript
import { execSync } from "../utils/shell"
import type { Session, Layout, Window, Pane } from "../types/tmux"

export class TmuxService {
  hasSession(name: string): boolean {
    const result = execSync("tmux", ["has-session", "-t", name])
    return result.success
  }

  createSession(name: string, workingDir: string): void {
    const result = execSync("tmux", ["new-session", "-d", "-s", name, "-c", workingDir])
    if (!result.success) throw new Error(`Failed to create session: ${result.stderr}`)
  }

  attachSession(name: string): void {
    if (this.isInsideTmux()) {
      const result = execSync("tmux", ["switch-client", "-t", name])
      if (!result.success) throw new Error(`Failed to switch client: ${result.stderr}`)
    } else {
      const result = execSync("tmux", ["attach-session", "-t", name])
      if (!result.success) throw new Error(`Failed to attach session: ${result.stderr}`)
    }
  }

  private isInsideTmux(): boolean {
    return !!process.env.TMUX
  }

  // ... killSession, listSessions, listSessionsDetailed, applyLayout
}
```

### Task 3.1: Command Interface

**`tui/src/commands/Command.ts`:**

```typescript
export interface CommandResult {
  success: boolean
  message: string
  data?: unknown
}

export interface Command {
  execute(): Promise<CommandResult>
}
```

### Task 3.2: Example Command Implementation

**`tui/src/commands/CreateWorktreeCommand.ts`:**

```typescript
import type { Command, CommandResult } from "./Command"
import type { WorktreeService } from "../services/WorktreeService"
import type { GitService } from "../services/GitService"
import type { Repo } from "../types/repo"
import type { CreateOptions } from "../types/worktree"

export class CreateWorktreeCommand implements Command {
  constructor(
    private readonly worktreeService: WorktreeService,
    private readonly gitService: GitService,
    private readonly repo: Repo,
    private readonly branchName: string,
  ) {}

  async execute(): Promise<CommandResult> {
    try {
      // Check if branch already exists
      const branchInfo = this.gitService.getBranchInfo(this.repo.path, this.branchName)

      const opts: CreateOptions = {
        branch: this.branchName,
        baseBranch: branchInfo.exists ? "" : this.repo.defaultBranch,
        newBranch: !branchInfo.exists,
      }

      const worktree = await this.worktreeService.create(this.repo, opts)

      return {
        success: true,
        message: `Created worktree: ${worktree.branch}`,
        data: worktree,
      }
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : "Unknown error",
      }
    }
  }
}
```

### Task 4.1: App Reducer

**`tui/src/state/actions.ts`:**

```typescript
import type { Repo } from "../types/repo"
import type { Worktree } from "../types/worktree"
import type { CheckResult } from "../types/safety"

export type Panel = "repos" | "worktrees" | "detail"
export type InputMode = "none" | "create"
export type DialogType = "none" | "delete" | "orphanCleanup" | "pruneOrphans" | "help"

export type AppAction =
  | { type: "SET_REPOS"; repos: Repo[] }
  | { type: "SET_WORKTREES"; worktrees: Worktree[] }
  | { type: "SELECT_REPO"; repo: Repo }
  | { type: "SELECT_WORKTREE"; worktree: Worktree }
  | { type: "SET_FOCUSED_PANEL"; panel: Panel }
  | { type: "CYCLE_PANEL_FORWARD" }
  | { type: "CYCLE_PANEL_BACKWARD" }
  | { type: "SET_INPUT_MODE"; mode: InputMode }
  | { type: "SHOW_DIALOG"; dialogType: DialogType; title: string; message: string }
  | { type: "CLOSE_DIALOG" }
  | { type: "SET_ERROR"; message: string }
  | { type: "SET_STATUS"; message: string }
  | { type: "CLEAR_MESSAGES" }
  | { type: "SET_SAFETY_RESULT"; result: CheckResult; worktree: Worktree }
  | { type: "SET_LOADING"; loading: boolean }
```

**`tui/src/state/appReducer.ts`:**

```typescript
import type { AppAction, Panel, InputMode, DialogType } from "./actions"
import type { Repo } from "../types/repo"
import type { Worktree } from "../types/worktree"
import type { CheckResult } from "../types/safety"

export interface AppState {
  repos: Repo[]
  worktrees: Worktree[]
  selectedRepo: Repo | null
  selectedWorktree: Worktree | null
  focusedPanel: Panel
  inputMode: InputMode
  dialogType: DialogType
  dialogTitle: string
  dialogMessage: string
  showDialog: boolean
  errorMessage: string
  statusMessage: string
  confirmForce: boolean
  loading: boolean
}

export const initialState: AppState = {
  repos: [],
  worktrees: [],
  selectedRepo: null,
  selectedWorktree: null,
  focusedPanel: "repos",
  inputMode: "none",
  dialogType: "none",
  dialogTitle: "",
  dialogMessage: "",
  showDialog: false,
  errorMessage: "",
  statusMessage: "",
  confirmForce: false,
  loading: true,
}

const PANELS: Panel[] = ["repos", "worktrees", "detail"]

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "SET_REPOS":
      return { ...state, repos: action.repos, loading: false }
    case "SET_WORKTREES":
      return {
        ...state,
        worktrees: action.worktrees,
        selectedWorktree: null,
      }
    case "SELECT_REPO":
      return { ...state, selectedRepo: action.repo }
    case "SELECT_WORKTREE":
      return { ...state, selectedWorktree: action.worktree }
    case "SET_FOCUSED_PANEL":
      return { ...state, focusedPanel: action.panel }
    case "CYCLE_PANEL_FORWARD": {
      const idx = PANELS.indexOf(state.focusedPanel)
      return { ...state, focusedPanel: PANELS[(idx + 1) % PANELS.length] }
    }
    case "CYCLE_PANEL_BACKWARD": {
      const idx = PANELS.indexOf(state.focusedPanel)
      return { ...state, focusedPanel: PANELS[(idx + 2) % PANELS.length] }
    }
    case "SET_INPUT_MODE":
      return { ...state, inputMode: action.mode, errorMessage: "" }
    case "SHOW_DIALOG":
      return {
        ...state,
        showDialog: true,
        dialogType: action.dialogType,
        dialogTitle: action.title,
        dialogMessage: action.message,
      }
    case "CLOSE_DIALOG":
      return {
        ...state,
        showDialog: false,
        dialogType: "none",
        dialogTitle: "",
        dialogMessage: "",
        confirmForce: false,
      }
    case "SET_ERROR":
      return { ...state, errorMessage: action.message, statusMessage: "" }
    case "SET_STATUS":
      return { ...state, statusMessage: action.message, errorMessage: "" }
    case "CLEAR_MESSAGES":
      return { ...state, errorMessage: "", statusMessage: "" }
    case "SET_SAFETY_RESULT":
      return { ...state, confirmForce: !action.result.safe }
    case "SET_LOADING":
      return { ...state, loading: action.loading }
    default:
      return state
  }
}
```

### Task 4.2: React Context Provider

**`tui/src/state/AppContext.tsx`:**

```tsx
import { createContext, useReducer, useMemo, type ReactNode } from "react"
import { appReducer, initialState, type AppState } from "./appReducer"
import type { AppAction } from "./actions"
import type { ConfigService } from "../services/ConfigService"
import type { GitService } from "../services/GitService"
import type { TmuxService } from "../services/TmuxService"
import type { RepoService } from "../services/RepoService"
import type { WorktreeService } from "../services/WorktreeService"
import type { SafetyService } from "../services/SafetyService"
import type { StatusService } from "../services/StatusService"
import type { StateService } from "../services/StateService"

export interface Services {
  config: ConfigService
  git: GitService
  tmux: TmuxService
  repo: RepoService
  worktree: WorktreeService
  safety: SafetyService
  status: StatusService
  state: StateService
}

interface AppContextValue {
  state: AppState
  dispatch: React.Dispatch<AppAction>
  services: Services
}

export const AppContext = createContext<AppContextValue | null>(null)

interface AppProviderProps {
  services: Services
  children: ReactNode
}

export function AppProvider({ services, children }: AppProviderProps) {
  const [state, dispatch] = useReducer(appReducer, initialState)

  const value = useMemo(
    () => ({ state, dispatch, services }),
    [state, dispatch, services],
  )

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  )
}
```

### Task 5.1: Entry Point

**`tui/src/index.tsx`:**

```tsx
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { App } from "./App"
import { AppProvider, type Services } from "./state/AppContext"
import { ConfigService } from "./services/ConfigService"
import { GitService } from "./services/GitService"
import { TmuxService } from "./services/TmuxService"
import { RepoService } from "./services/RepoService"
import { WorktreeService } from "./services/WorktreeService"
import { SafetyService } from "./services/SafetyService"
import { StatusService } from "./services/StatusService"
import { StateService } from "./services/StateService"

// Initialize services
const configService = new ConfigService()
const config = await configService.load()

const gitService = new GitService()
const tmuxService = new TmuxService()
const stateService = new StateService(config.aiWorkingDir)
const repoService = new RepoService(config, gitService)
const worktreeService = new WorktreeService(config, gitService, stateService)
const safetyService = new SafetyService(gitService)
const statusService = new StatusService(gitService, config.statusCacheTTL)

const services: Services = {
  config: configService,
  git: gitService,
  tmux: tmuxService,
  repo: repoService,
  worktree: worktreeService,
  safety: safetyService,
  status: statusService,
  state: stateService,
}

// Create renderer
const renderer = await createCliRenderer({
  exitOnCtrlC: false, // Handle Ctrl+C ourselves for cleanup
})

// Render app
createRoot(renderer).render(
  <AppProvider services={services}>
    <App renderer={renderer} />
  </AppProvider>,
)
```

### Task 5.2: Panel Component

**`tui/src/components/Panel.tsx`:**

```tsx
import type { ReactNode } from "react"

interface PanelProps {
  title: string
  focused: boolean
  children: ReactNode
}

export function Panel({ title, focused, children }: PanelProps) {
  const borderColor = focused ? "#4455FF" : "#555555"
  const titleColor = "#6366F1"

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={borderColor}
      flexGrow={1}
      flexDirection="column"
      paddingX={1}
    >
      <text>
        <span fg={titleColor}><strong>{title}</strong></span>
      </text>
      <box flexGrow={1} flexDirection="column" marginTop={1}>
        {children}
      </box>
    </box>
  )
}
```

### Task 5.3: RepoList Component

**`tui/src/components/RepoList.tsx`:**

Use OpenTUI's `<select>` component for the list:

```tsx
import { useCallback, useMemo } from "react"
import type { Repo } from "../types/repo"

interface RepoListProps {
  repos: Repo[]
  selectedIndex: number
  focused: boolean
  onSelect: (repo: Repo) => void
  onChange: (repo: Repo) => void
}

export function RepoList({ repos, selectedIndex, focused, onSelect, onChange }: RepoListProps) {
  const options = useMemo(
    () => repos.map((r) => ({
      name: r.name,
      description: r.path,
      value: r,
    })),
    [repos],
  )

  const handleChange = useCallback(
    (index: number, option: { value: Repo }) => {
      onChange(option.value)
    },
    [onChange],
  )

  const handleSelect = useCallback(
    (index: number, option: { value: Repo }) => {
      onSelect(option.value)
    },
    [onSelect],
  )

  if (repos.length === 0) {
    return <text fg="#888888">No repositories found</text>
  }

  return (
    <select
      options={options}
      selectedIndex={selectedIndex}
      focused={focused}
      onChange={handleChange}
      onSelect={handleSelect}
      showScrollIndicator
    />
  )
}
```

### Task 6.1: Keyboard Handler

**`tui/src/hooks/useKeyboardShortcuts.ts`:**

The keyboard handler must respect the priority chain: dialog > input > normal.

```tsx
import { useCallback } from "react"
import { useKeyboard, useRenderer } from "@opentui/react"
import type { AppState } from "../state/appReducer"
import type { AppAction } from "../state/actions"

interface KeyboardOptions {
  state: AppState
  dispatch: React.Dispatch<AppAction>
  onQuit: () => void
  onCreateWorktree: (branch: string) => void
  onOpenWorktree: () => void
  onDeleteWorktree: () => void
  onRefresh: () => void
  onPrune: () => void
  onCopy: () => void
  onCopyBranch: () => void
  onHelp: () => void
  onDialogConfirm: () => void
}

export function useKeyboardShortcuts(opts: KeyboardOptions) {
  const renderer = useRenderer()

  useKeyboard((key) => {
    // Priority 1: Dialog mode
    if (opts.state.showDialog) {
      handleDialogKey(key, opts)
      return
    }

    // Priority 2: Input mode
    if (opts.state.inputMode !== "none") {
      // Input component handles its own keys via focused prop
      // We only handle Esc here
      if (key.name === "escape") {
        opts.dispatch({ type: "SET_INPUT_MODE", mode: "none" })
      }
      return
    }

    // Priority 3: Normal mode
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      renderer.destroy()
      return
    }

    switch (key.name) {
      case "tab":
        if (key.shift) {
          opts.dispatch({ type: "CYCLE_PANEL_BACKWARD" })
        } else {
          opts.dispatch({ type: "CYCLE_PANEL_FORWARD" })
        }
        break
      case "n": opts.dispatch({ type: "SET_INPUT_MODE", mode: "create" }); break
      case "o": opts.onOpenWorktree(); break
      case "d": opts.onDeleteWorktree(); break
      case "r": opts.onRefresh(); break
      case "p": opts.onPrune(); break
      case "c": opts.onCopy(); break
      case "b": opts.onCopyBranch(); break
      case "?": opts.onHelp(); break
    }
  })
}
```

---

## Testing Strategy

### Test Runner

Use Bun's built-in test runner:
```bash
bun test
```

### Service Tests (Unit)

Each service is tested by mocking the `shell.ts` `execSync`/`exec` functions:

```typescript
// tui/src/__tests__/services/GitService.test.ts
import { test, expect, mock } from "bun:test"
import { GitService } from "../../services/GitService"

// Mock shell.execSync to return known git output
test("worktreeList parses porcelain output", () => {
  // Setup mock to return known porcelain output
  const git = new GitService()
  // ... test that parsing works correctly
})
```

### Utility Tests (Unit)

```typescript
// tui/src/__tests__/utils/slug.test.ts
import { test, expect } from "bun:test"
import { generateSlug, generateUniqueSlug } from "../../utils/slug"

test("converts branch name to slug", () => {
  expect(generateSlug("feature/auth-flow")).toBe("feature_auth-flow")
  expect(generateSlug("fix/bug///extra")).toBe("fix_bug_extra")
})

test("handles collisions", () => {
  const existing = new Set(["feature_auth"])
  expect(generateUniqueSlug("feature/auth", existing)).toBe("feature_auth_2")
})
```

### Component Tests (Snapshot)

Using OpenTUI's React test utilities:

```tsx
// tui/src/__tests__/components/RepoList.test.tsx
import { test, expect, afterEach } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { RepoList } from "../../components/RepoList"

let testSetup: Awaited<ReturnType<typeof testRender>>

afterEach(() => {
  if (testSetup) testSetup.renderer.destroy()
})

test("renders repo list", async () => {
  const repos = [
    { name: "my-project", path: "/home/user/repos/my-project", defaultBranch: "main", lastScanned: new Date() },
  ]

  testSetup = await testRender(
    <RepoList repos={repos} selectedIndex={0} focused={true} onSelect={() => {}} onChange={() => {}} />,
    { width: 40, height: 20 },
  )

  await testSetup.renderOnce()
  expect(testSetup.captureCharFrame()).toContain("my-project")
})
```

### Manual Testing Checklist

1. Launch app: `cd tui && bun run start`
2. Verify 3-panel layout renders
3. Tab through panels -- focus highlight changes
4. j/k navigation in repo list
5. Enter on repo loads worktrees in middle panel
6. Select worktree shows details in right panel
7. `n` opens create input, type branch name, Enter creates
8. `o` opens worktree in tmux (quits TUI)
9. `d` shows safety check dialog, confirm deletes
10. `p` prunes orphaned worktrees
11. `c` copies path to clipboard
12. `b` copies branch name
13. `?` shows help dialog
14. `q` quits cleanly (terminal restored)
15. Terminal resize reflows layout

### Commands

```bash
# Run all tests
cd tui && bun test

# Run specific test file
bun test src/__tests__/services/GitService.test.ts

# Run with watch mode
bun test --watch

# Update snapshots
bun test --update-snapshots
```

---

## Definition of Done

- [ ] All Phase 1-6 tasks completed
- [ ] All Phase 7 tests written and passing
- [ ] `bun test` passes with 0 failures
- [ ] `tsc --noEmit` passes with 0 errors (run from `tui/`)
- [ ] `bunx biome check .` passes with 0 errors (run from `tui/`)
- [ ] App launches with `bun run src/index.tsx` and renders correctly
- [ ] All keyboard shortcuts match the existing Go TUI behavior
- [ ] `.swarm-state.json` format is backward-compatible with Go version
- [ ] Config file reading works identically to Go version
- [ ] `renderer.destroy()` is used for exit (never `process.exit()`)
- [ ] Code follows project conventions (OOP services, Command pattern, no default exports)
- [ ] No direct git/tmux/filesystem calls from UI components

### Linting & Type Checking Commands

| Check | Command | Run From |
|-------|---------|----------|
| Type check | `tsc --noEmit` | `tui/` |
| Lint | `bunx biome check .` | `tui/` |
| Lint + fix | `bunx biome check --write .` | `tui/` |
| Tests | `bun test` | `tui/` |
| Dev mode | `bun --watch run src/index.tsx` | `tui/` |

---

## Architecture Diagram

```
tui/src/index.tsx
    |
    |  Creates services, renderer, renders <AppProvider>
    v
state/AppContext.tsx          -- React Context: services + useReducer(appReducer)
    |
    v
App.tsx                       -- Root: useKeyboardShortcuts + conditional rendering
    |
    +--- components/Panel.tsx        -- Reusable bordered panel
    +--- components/RepoList.tsx     -- <select> with repos
    +--- components/WorktreeList.tsx  -- <select> with worktrees + badges
    +--- components/DetailView.tsx   -- Text-based detail view
    +--- components/StatusBar.tsx    -- Bottom status bar
    +--- components/Dialog.tsx       -- Modal confirmation
    +--- components/InputDialog.tsx  -- Modal text input
    +--- components/HelpDialog.tsx   -- Help overlay
    |
    |  Components dispatch actions & call commands
    v
commands/                     -- Command pattern (encapsulates service calls)
    +--- CreateWorktreeCommand.ts
    +--- OpenWorktreeCommand.ts
    +--- DeleteWorktreeCommand.ts
    +--- RefreshCommand.ts
    +--- PruneOrphansCommand.ts
    +--- CopyToClipboardCommand.ts
    |
    |  Commands call services
    v
services/                     -- OOP service classes (business logic)
    +--- ConfigService.ts     -- YAML config + env vars
    +--- GitService.ts        -- git CLI wrapper
    +--- TmuxService.ts       -- tmux CLI wrapper
    +--- RepoService.ts       -- repo discovery
    +--- WorktreeService.ts   -- worktree CRUD
    +--- SafetyService.ts     -- pre-removal checks
    +--- StatusService.ts     -- status + badges + caching
    +--- StateService.ts      -- JSON state with file locking
    +--- ClipboardService.ts  -- OSC52 clipboard
    |
    |  Services use utilities
    v
utils/
    +--- shell.ts             -- Bun.spawnSync / Bun.spawn wrappers
    +--- slug.ts              -- Branch-to-slug conversion
    +--- git-parser.ts        -- Git output parsers
    +--- result.ts            -- Result<T, E> type
```

### Data Flow

```
User Keyboard Input
      |
      v
useKeyboardShortcuts (hook)
      |
      v
Creates Command instance  ------>  Command.execute()
      |                                    |
      v                                    v
dispatch(action)                   Service methods (git, tmux, etc.)
      |                                    |
      v                                    v
appReducer                          Shell commands (Bun.spawnSync)
      |                                    |
      v                                    v
New AppState                        Side effects (files, processes)
      |
      v
React re-render
```

---

## Key Gotchas & Edge Cases

1. **Never call `process.exit()`** -- always use `renderer.destroy()` (OpenTUI cleans up terminal state)
2. **`<select>` options must be `{ name, description?, value? }` objects** -- not plain strings
3. **`<select>` `onSelect` fires on Enter, `onChange` fires on arrow keys** -- don't confuse them
4. **`focused` prop is required** on `<input>` and `<select>` for them to receive keyboard input
5. **`jsxImportSource: "@opentui/react"`** must be in tsconfig or JSX types break
6. **Parent must have explicit dimensions** for `flexGrow` and `%` sizing to work
7. **`Bun.spawnSync`** is synchronous and blocks -- use for git/tmux commands (they're fast); use async `Bun.spawn` for potentially long operations
8. **File locking** with `proper-lockfile` is essential for `.swarm-state.json` to prevent corruption on concurrent access
9. **Session naming convention**: TUI uses `<repo>--wt--<slug>` format (note double dash separator)
10. **Tmux attach vs switch**: Must detect if inside tmux via `$TMUX` env var and use `switch-client` vs `attach-session` accordingly
11. **Worktree pattern**: Default is `patternA` = `ai_working/<repo>__wt__<slug>` (flat sibling directories)
12. **Multiple `useKeyboard` hooks fire for every keypress** -- implement mode checks to prevent conflicts
