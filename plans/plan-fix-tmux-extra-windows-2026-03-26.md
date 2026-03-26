# Implementation Plan: Fix Extra Tmux Windows on Worktree Open

Generated: 2026-03-26

## Summary

When a user opens a worktree via the Swarm TUI, a tmux session is created with the correct working directory, but **two extra windows** (`shell` and `tests`) are also created that the user did not request. This happens because `OpenWorktreeCommand` unconditionally applies a 3-window "default layout" (editor, shell, tests) after creating the session. The fix is to stop applying this default layout so the session is created with only the single initial window that `tmux new-session` provides.

**Root cause:** In `OpenWorktreeCommand.execute()` (line 29-30), after `createSession()` creates a clean session with 1 window, `applyLayout(sessionName, defaultLayout())` immediately adds 2 more windows (`shell`, `tests`) and renames the first to `editor`. These extra windows are unwanted.

**Why it looks like "cloning":** The extra windows appear to come from the source session because they are bare shells with no commands — just empty terminal windows pointing at the worktree directory. The user sees 3 windows where they expected 1.

## Prerequisites

- **Runtime:** Bun >= 1.0
- **Dev dependencies installed:** `cd tui && bun install`
- **Familiarity with:**
  - The command pattern used in `tui/src/commands/` — each command has an `execute(): Promise<CommandResult>` method
  - `TmuxService` at `tui/src/services/TmuxService.ts` — wraps `tmux` CLI calls
  - Bun test runner (`bun test`) — tests are in `tui/src/__tests__/`
- **Linting:** `bunx biome check .` (from `tui/`)
- **Type checking:** `tsc --noEmit` (from `tui/`)

## Task Breakdown

### Task 1: Remove default layout application from `OpenWorktreeCommand`

- **Complexity:** Low
- **Dependencies:** None
- **Files to modify:** `tui/src/commands/OpenWorktreeCommand.ts`
- **Acceptance criteria:**
  - When opening a worktree that has no existing tmux session, only 1 window is created (the default window from `tmux new-session`)
  - The session's single window has its `pwd` set to the worktree directory
  - No `applyLayout` or `defaultLayout` call occurs in the open flow

### Task 2: Clean up unused `defaultLayout()` and potentially `applyLayout()` from `TmuxService`

- **Complexity:** Low
- **Dependencies:** Requires Task 1
- **Files to modify:** `tui/src/services/TmuxService.ts`
- **Acceptance criteria:**
  - If `defaultLayout()` is no longer called anywhere in the codebase, remove it
  - If `applyLayout()` is no longer called anywhere in the codebase, remove it
  - If `applyLayout` is still referenced (e.g., for future custom layout support via `tmuxLayoutScript` config), keep it but remove `defaultLayout()`
  - No dead code remains

### Task 3: Write/update unit tests for `OpenWorktreeCommand`

- **Complexity:** Medium
- **Dependencies:** Requires Task 1
- **Files to create:** `tui/src/__tests__/commands/OpenWorktreeCommand.test.ts`
- **Acceptance criteria:**
  - Test: when session does NOT exist, `createSession` is called with the worktree path, and `applyLayout` is NOT called
  - Test: when session already exists, `createSession` is NOT called
  - Test: `attachSession` is always called
  - Test: `updateLastOpened` is called on success
  - All tests pass with `bun test`

### Task 4: Run linter and type checker

- **Complexity:** Low
- **Dependencies:** Requires Tasks 1-3
- **Acceptance criteria:**
  - `bunx biome check .` passes with no errors (run from `tui/`)
  - `tsc --noEmit` passes with no errors (run from `tui/`)

## Implementation Details

### Task 1: Remove default layout application from `OpenWorktreeCommand`

**File:** `tui/src/commands/OpenWorktreeCommand.ts`

The current code at lines 26-31:

```typescript
if (!this.tmuxService.hasSession(sessionName)) {
  // Create new session and apply default layout
  this.tmuxService.createSession(sessionName, this.worktree.path)
  const layout = this.tmuxService.defaultLayout()
  this.tmuxService.applyLayout(sessionName, layout)
}
```

Change to:

```typescript
if (!this.tmuxService.hasSession(sessionName)) {
  this.tmuxService.createSession(sessionName, this.worktree.path)
}
```

That's it. `tmux new-session -d -s <name> -c <dir>` already creates a session with exactly 1 window whose working directory is `<dir>`. The `defaultLayout()` call was adding 2 extra windows (`shell`, `tests`) and renaming the first to `editor`.

**Gotchas:**
- The config has a `tmuxLayoutScript` field (see `tui/src/types/config.ts:31`) and `createSessionOnCreate` (line 29). These are not currently wired into `OpenWorktreeCommand` — they are future features. Do NOT wire them in as part of this fix. Just remove the hardcoded default layout. If custom layout support is needed later, it should be a separate feature.

### Task 2: Clean up unused code from `TmuxService`

**File:** `tui/src/services/TmuxService.ts`

After Task 1, search the entire codebase for usages of:
- `defaultLayout` — if no callers remain, remove the method (lines 178-191)
- `applyLayout` — if no callers remain, remove the method (lines 139-176)

Use these commands to verify:
```bash
# From the tui/ directory
grep -r "defaultLayout" src/ --include="*.ts" --include="*.tsx"
grep -r "applyLayout" src/ --include="*.ts" --include="*.tsx"
```

Also check if the `Layout`, `Window`, `Pane`, `PaneDirection` types in `tui/src/types/tmux.ts` are still used anywhere. If they are only used by the removed methods, remove them too.

**Gotchas:**
- Keep the `Layout` type and `applyLayout` method if you anticipate the `tmuxLayoutScript` config option being implemented soon. Use your judgment — the cleaner approach is to remove dead code now and re-add it when needed.

### Task 3: Write unit tests for `OpenWorktreeCommand`

**File to create:** `tui/src/__tests__/commands/OpenWorktreeCommand.test.ts`

Follow the existing test pattern from `DeleteWorktreeCommand.test.ts`:
- Use `bun:test` imports (`describe`, `expect`, `mock`, `test`)
- Create mock services with `mock()` functions
- Cast mocks as `never` when passing to command constructors

```typescript
import { describe, expect, mock, test } from "bun:test"
import { OpenWorktreeCommand } from "../../commands/OpenWorktreeCommand.js"
import type { Repo } from "../../types/repo.js"
import type { Worktree } from "../../types/worktree.js"

const repo: Repo = {
  name: "test-repo",
  path: "/repos/test-repo",
  defaultBranch: "main",
  lastScanned: new Date(),
}

const worktree: Worktree = {
  slug: "feature-x",
  branch: "feature/x",
  path: "/repos/test-repo__wt__feature-x",
  repoName: "test-repo",
  createdAt: new Date(),
  lastOpenedAt: new Date(),
  tmuxSession: "test-repo--wt--feature-x",
  isOrphaned: false,
}

describe("OpenWorktreeCommand", () => {
  test("creates session and attaches when session does not exist", async () => {
    const mockTmuxService = {
      hasSession: mock(() => false),
      createSession: mock(() => {}),
      attachSession: mock(() => {}),
    }
    const mockWorktreeService = {
      updateLastOpened: mock(() => Promise.resolve()),
    }

    const cmd = new OpenWorktreeCommand(
      mockTmuxService as never,
      mockWorktreeService as never,
      repo,
      worktree,
    )
    const result = await cmd.execute()

    expect(result.success).toBe(true)
    expect(mockTmuxService.createSession).toHaveBeenCalledWith(
      "test-repo--wt--feature-x",
      "/repos/test-repo__wt__feature-x",
    )
    expect(mockTmuxService.attachSession).toHaveBeenCalledWith("test-repo--wt--feature-x")
  })

  test("does not create session when it already exists", async () => {
    const mockTmuxService = {
      hasSession: mock(() => true),
      createSession: mock(() => {}),
      attachSession: mock(() => {}),
    }
    const mockWorktreeService = {
      updateLastOpened: mock(() => Promise.resolve()),
    }

    const cmd = new OpenWorktreeCommand(
      mockTmuxService as never,
      mockWorktreeService as never,
      repo,
      worktree,
    )
    const result = await cmd.execute()

    expect(result.success).toBe(true)
    expect(mockTmuxService.createSession).not.toHaveBeenCalled()
    expect(mockTmuxService.attachSession).toHaveBeenCalledWith("test-repo--wt--feature-x")
  })

  test("does NOT apply any layout (no extra windows)", async () => {
    const mockTmuxService = {
      hasSession: mock(() => false),
      createSession: mock(() => {}),
      attachSession: mock(() => {}),
      applyLayout: mock(() => {}),
      defaultLayout: mock(() => ({ windows: [] })),
    }
    const mockWorktreeService = {
      updateLastOpened: mock(() => Promise.resolve()),
    }

    const cmd = new OpenWorktreeCommand(
      mockTmuxService as never,
      mockWorktreeService as never,
      repo,
      worktree,
    )
    await cmd.execute()

    expect(mockTmuxService.applyLayout).not.toHaveBeenCalled()
    expect(mockTmuxService.defaultLayout).not.toHaveBeenCalled()
  })

  test("updates last opened timestamp on success", async () => {
    const mockTmuxService = {
      hasSession: mock(() => true),
      attachSession: mock(() => {}),
    }
    const mockWorktreeService = {
      updateLastOpened: mock(() => Promise.resolve()),
    }

    const cmd = new OpenWorktreeCommand(
      mockTmuxService as never,
      mockWorktreeService as never,
      repo,
      worktree,
    )
    await cmd.execute()

    expect(mockWorktreeService.updateLastOpened).toHaveBeenCalledWith(repo, worktree)
  })

  test("returns failure on error", async () => {
    const mockTmuxService = {
      hasSession: mock(() => { throw new Error("tmux not found") }),
    }
    const mockWorktreeService = {
      updateLastOpened: mock(() => Promise.resolve()),
    }

    const cmd = new OpenWorktreeCommand(
      mockTmuxService as never,
      mockWorktreeService as never,
      repo,
      worktree,
    )
    const result = await cmd.execute()

    expect(result.success).toBe(false)
    expect(result.message).toContain("tmux not found")
  })
})
```

### Task 4: Run linter and type checker

```bash
# From tui/ directory
bun test                  # All tests pass
bunx biome check .        # No lint errors
tsc --noEmit              # No type errors (via: bun run typecheck)
```

## Testing Strategy

### Unit Tests

| Test File | What It Covers |
|---|---|
| `tui/src/__tests__/commands/OpenWorktreeCommand.test.ts` (NEW) | All open-worktree scenarios: new session, existing session, no layout applied, error handling |

Run with:
```bash
cd tui && bun test
```

### Manual Testing

1. Start the Swarm TUI: `cd tui && bun run start`
2. Select a repository
3. Press `n` to create a new worktree (enter a branch name)
4. Press `Enter`/`o` to open the newly created worktree
5. **Verify:** The tmux session has exactly **1 window**, with `pwd` set to the worktree directory
6. **Verify:** No extra `editor`, `shell`, or `tests` windows exist
7. Exit tmux (`Ctrl-b d` to detach), relaunch the TUI
8. Open the same worktree again
9. **Verify:** The existing session is reattached (not recreated), still 1 window

### Edge Cases to Verify

- Opening a worktree whose tmux session already exists (should just attach, not add windows)
- Opening a worktree after deleting its tmux session externally (`tmux kill-session -t <name>`)
- The `createSessionOnCreate` config flag does NOT affect this — it's not wired in yet

## Definition of Done

- [x] Task 1: `OpenWorktreeCommand` no longer calls `applyLayout` or `defaultLayout`
- [x] Task 2: Dead code (`defaultLayout`, possibly `applyLayout`) removed from `TmuxService`
- [x] Task 3: Unit tests written and passing for `OpenWorktreeCommand`
- [x] Task 4: `bun test` — all tests pass
- [x] Task 4: `bunx biome check .` — no lint offenses (run from `tui/`)
- [x] Task 4: `bun run typecheck` (`tsc --noEmit`) — no type errors (run from `tui/`)
- [x] Manual verification: opening a worktree creates a tmux session with exactly 1 window
