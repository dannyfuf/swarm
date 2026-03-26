# Implementation Plan: Fix TUI Reactivity for Worktree Create/Delete Operations

Generated: 2026-03-26

## Summary

The TUI becomes unresponsive when creating or removing worktrees. After pressing Enter to confirm, the dialog sometimes stays visible for seconds, the activity spinner (notification card) doesn't appear immediately, and occasionally the worktree just appears without any feedback. In extreme cases, repeated Enter presses cause a segfault crash in Bun. The root cause is that **synchronous `Bun.spawnSync` calls in `GitService` block the main thread**, preventing React from processing state updates (dialog dismiss, activity spinner begin) before the heavy work starts. The fix is to make the operation lifecycle **optimistic**: dismiss the dialog and show the spinner *synchronously via dispatch*, then defer all blocking work to the next microtask/tick so React can flush the UI update first.

### Root Cause Analysis

1. **Blocking main thread during command execution.** When `handleCreateWorktree` runs:
   - It dispatches `SET_INPUT_MODE: "none"` (should dismiss dialog)
   - Then *immediately* calls `trackActivity(...)` which dispatches `BEGIN_ACTIVITY` (should show spinner)
   - Then *immediately* calls `cmd.execute()` which runs `gitService.getBranchInfo()` — a function that calls `Bun.spawnSync` **4-6 times sequentially** (rev-parse, rev-list, log, branch --contains)
   - Then calls `worktreeService.create()` which calls `git.worktreeAdd()` (another `Bun.spawnSync`)
   - **Because all this is synchronous and happens in the same microtask as the dispatches, React never gets a chance to flush the pending state updates to the renderer.** The dialog stays visible, the spinner never appears, and the UI appears frozen.

2. **Same problem with delete.** `handleConfirmDelete` dispatches `CLOSE_DIALOG` then immediately runs `DeleteWorktreeCommand.execute()` which calls synchronous `tmuxService.hasSession()`, `tmuxService.killSession()`, `git.worktreeRemove()`, `git.worktreeList()`, `git.isMerged()`, `git.deleteBranch()` — all blocking `Bun.spawnSync`.

3. **Segfault trigger.** When the user presses Enter repeatedly while the main thread is blocked, keyboard events queue up. When execution finally returns, all queued events fire at once, potentially triggering concurrent `Bun.spawnSync` calls or corrupting OpenTUI's internal renderer state. This is a Bun bug, but we can avoid it entirely by ensuring the UI stays responsive.

### Design Principle

**Optimistic UI + Deferred Execution**: All state updates that affect the UI (dismiss dialog, show spinner, set status) must happen *and flush to the terminal* before any blocking work begins. The blocking work should run in a `setTimeout(fn, 0)` or `queueMicrotask` wrapper to yield control back to React's reconciler first.

## Prerequisites

### Environment
- **Runtime:** Bun >= 1.3.x
- **Framework:** OpenTUI with React reconciler (`@opentui/react`)
- **Working directory:** `tui/` (all paths relative to repo root)

### Required Knowledge
- React `useReducer` + Context pattern (state management in `tui/src/state/`)
- OpenTUI rendering model: React dispatches update virtual tree, renderer flushes to terminal
- `Bun.spawnSync` blocks the JavaScript event loop entirely (no microtask processing)
- `Bun.spawn` (async) does NOT block — it returns immediately and resolves via promises

### Key Files
| File | Role |
|------|------|
| `tui/src/App.tsx` | All command callbacks, the orchestration layer |
| `tui/src/utils/activity.ts` | `trackActivity` wrapper that dispatches BEGIN/END_ACTIVITY |
| `tui/src/services/GitService.ts` | All git operations (synchronous `Bun.spawnSync`) |
| `tui/src/commands/CreateWorktreeCommand.ts` | Orchestrates worktree creation |
| `tui/src/commands/CreateAndStartWorktreeCommand.ts` | Orchestrates create + container start |
| `tui/src/commands/DeleteWorktreeCommand.ts` | Orchestrates worktree deletion |
| `tui/src/services/WorktreeService.ts` | CRUD for worktrees (calls GitService + StateService) |
| `tui/src/components/InputDialog.tsx` | Branch name input dialog |
| `tui/src/components/Dialog.tsx` | Confirmation dialog |
| `tui/src/hooks/useKeyboardShortcuts.ts` | Global keyboard handler |
| `tui/src/utils/shell.ts` | `execSync` (blocking) and `exec` (async) wrappers |
| `tui/src/state/appReducer.ts` | Reducer with all state transitions |

### Coding Conventions
- **Biome** for linting/formatting: `bunx biome check .`
- **TypeScript strict mode**: `tsc --noEmit`
- 2-space indent, double quotes, no semicolons (unless ASI-hazard)
- `noDefaultExport` rule enforced — all exports are named
- Import type assertions: `import type { X }` when only used as types
- JSDoc comments on public functions/interfaces

## Scope

### IN Scope
- Fix worktree creation flow to dismiss dialog and show spinner instantly
- Fix worktree deletion flow to dismiss dialog and show spinner instantly
- Convert blocking `GitService` methods used in create/delete paths to async
- Ensure `trackActivity` defers blocking work so React can flush UI first
- Add `ActivityKind` for delete operations (currently missing)
- Prevent duplicate command execution from repeated Enter presses

### OUT of Scope
- Refactoring App.tsx into smaller components (separate task)
- Adding React error boundaries (separate task)
- Caching improvements for `StatusService` or `ContainerRuntimeService`
- Auto-dismiss timers for status/error messages
- Making ALL GitService methods async (only the ones in create/delete hot paths)

## Task Breakdown

### Task 1: Add async git methods to GitService for create/delete hot paths
**Complexity:** Medium  
**Dependencies:** None  
**File:** `tui/src/services/GitService.ts`

**What to do:**
Add async versions of the methods called during worktree create and delete. These use `exec` (async `Bun.spawn`) instead of `execSync` (blocking `Bun.spawnSync`).

The blocking methods on the create path:
- `getBranchInfo()` — calls `branchExists`, `rev-list --count`, `rev-parse --abbrev-ref`, `log -1`, `isMerged` (5+ `Bun.spawnSync` calls)
- `worktreeAdd()` — 1 `Bun.spawnSync` call

The blocking methods on the delete path:
- `worktreeRemove()` / `worktreeRemoveForce()` — 1 call
- `worktreeList()` — 1 call (verification step)
- `isMerged()` — 2 calls (defaultBranch + branch --contains)
- `deleteBranch()` — 1 call
- `worktreePrune()` — 1 call

**Implementation approach:**

Add new async methods alongside existing sync ones (don't break existing callers). Name them with `Async` suffix or just make the existing methods async (preferred — the sync callers like `StatusService.compute` can be updated separately).

The cleanest approach: **add a new `execAsync` import and create async versions of each method that the create/delete paths call.** Keep the sync versions for now since `StatusService.compute()` and other code paths use them.

```typescript
// New async methods to add to GitService:

async worktreeAddAsync(repoPath: string, opts: AddOptions): Promise<void> {
  // Same args construction as worktreeAdd, but uses exec() instead of execSync()
}

async worktreeRemoveAsync(repoPath: string, worktreePath: string): Promise<void> { ... }
async worktreeRemoveForceAsync(repoPath: string, worktreePath: string): Promise<void> { ... }
async worktreeListAsync(repoPath: string): Promise<WorktreeInfo[]> { ... }
async worktreePruneAsync(repoPath: string): Promise<void> { ... }
async getBranchInfoAsync(repoPath: string, branch: string): Promise<BranchInfo> { ... }
async isMergedAsync(repoPath: string, branch: string): Promise<boolean> { ... }
async deleteBranchAsync(repoPath: string, branch: string, force?: boolean): Promise<void> { ... }
async branchExistsAsync(repoPath: string, branch: string): Promise<boolean> { ... }
```

**Pattern to follow** (from existing `exec` usage in `ContainerRuntimeService.ts:104`):
```typescript
import { exec } from "../utils/shell.js"

async worktreeAddAsync(repoPath: string, opts: AddOptions): Promise<void> {
  const args = ["-C", repoPath, "worktree", "add"]
  // ... same arg construction as sync version ...
  const result = await exec("git", args)
  if (!result.success) {
    throw new Error(`git worktree add failed: ${result.stderr}`)
  }
}
```

**Acceptance criteria:**
- [ ] All new async methods pass the same logic as their sync counterparts
- [ ] Both sync and async methods coexist (no breaking changes to existing callers)
- [ ] Typecheck passes: `bun run typecheck`

---

### Task 2: Update WorktreeService.create() and .remove() to use async git methods
**Complexity:** Low  
**Dependencies:** Requires Task 1  
**Files:** `tui/src/services/WorktreeService.ts`

**What to do:**
`WorktreeService.create()` and `WorktreeService.remove()` are already `async` (they `await` StateService calls). Update them to call the new async git methods instead of the sync ones.

**Changes in `create()`:**
```typescript
// Before:
this.git.worktreeAdd(repo.path, { ... })

// After:
await this.git.worktreeAddAsync(repo.path, { ... })
```

**Changes in `remove()`:**
```typescript
// Before:
this.git.worktreeRemoveForce(repo.path, wt.path)
this.git.worktreeRemove(repo.path, wt.path)
const remainingGitWorktrees = this.git.worktreeList(repo.path)
this.git.worktreePrune(repo.path)

// After:
await this.git.worktreeRemoveForceAsync(repo.path, wt.path)
await this.git.worktreeRemoveAsync(repo.path, wt.path)
const remainingGitWorktrees = await this.git.worktreeListAsync(repo.path)
await this.git.worktreePruneAsync(repo.path)
```

**Acceptance criteria:**
- [ ] `create()` no longer calls any sync git methods
- [ ] `remove()` no longer calls any sync git methods
- [ ] Typecheck passes

---

### Task 3: Update CreateWorktreeCommand and CreateAndStartWorktreeCommand to use async git
**Complexity:** Low  
**Dependencies:** Requires Task 1  
**Files:** `tui/src/commands/CreateWorktreeCommand.ts`, `tui/src/commands/CreateAndStartWorktreeCommand.ts`

**What to do:**
Both commands call `this.gitService.getBranchInfo()` synchronously at the start of `execute()`. Change to `await this.gitService.getBranchInfoAsync()`.

```typescript
// CreateWorktreeCommand.ts line 24 — Before:
const branchInfo = this.gitService.getBranchInfo(this.repo.path, this.branchName)

// After:
const branchInfo = await this.gitService.getBranchInfoAsync(this.repo.path, this.branchName)
```

Same change in `CreateAndStartWorktreeCommand.ts` line 25.

**Acceptance criteria:**
- [ ] Both commands use `getBranchInfoAsync`
- [ ] Typecheck passes

---

### Task 4: Update DeleteWorktreeCommand to use async git methods
**Complexity:** Low  
**Dependencies:** Requires Task 1  
**Files:** `tui/src/commands/DeleteWorktreeCommand.ts`

**What to do:**
Replace sync git calls with async equivalents:

```typescript
// Line 47 — Before:
if (this.gitService.isMerged(this.repo.path, this.worktree.branch)) {
  this.gitService.deleteBranch(this.repo.path, this.worktree.branch)
}

// After:
if (await this.gitService.isMergedAsync(this.repo.path, this.worktree.branch)) {
  await this.gitService.deleteBranchAsync(this.repo.path, this.worktree.branch)
}
```

**Acceptance criteria:**
- [ ] All sync git calls in DeleteWorktreeCommand replaced with async
- [ ] Typecheck passes

---

### Task 5: Add delete-worktree ActivityKind and wrap deletion in trackActivity
**Complexity:** Medium  
**Dependencies:** Requires Task 4  
**Files:** `tui/src/types/activity.ts`, `tui/src/App.tsx`

**What to do:**

Currently, worktree deletion does NOT use `trackActivity`. The delete flow goes: close dialog -> execute command -> refresh. There's no spinner. Add it.

**5a. Add `"delete-worktree"` to `ActivityKind` union:**
```typescript
// tui/src/types/activity.ts
export type ActivityKind =
  | "build-container-image"
  | "create-and-start-worktree"
  | "create-worktree"
  | "delete-worktree"    // <-- NEW
  | "refresh"
  | "start-container"
```

**5b. Add activity factory function in App.tsx:**
```typescript
function createDeleteWorktreeActivity(repoPath: string, branch: string): ActivityDraft {
  return {
    kind: "delete-worktree",
    label: `Deleting worktree ${branch}...`,
    priority: "foreground",
    scope: { repoPath, branch },
  }
}
```

**5c. Wrap `handleConfirmDelete` in `trackActivity`:**
```typescript
const handleConfirmDelete = useCallback(async () => {
  dispatch({ type: "CLOSE_DIALOG" })
  if (!state.selectedRepo || !state.safetyWorktree) return

  const worktreeToDelete = state.safetyWorktree
  const repoForDelete = state.selectedRepo
  const hasWarnings = state.safetyResult?.warnings && state.safetyResult.warnings.length > 0

  await trackActivity(
    createDeleteWorktreeActivity(repoForDelete.path, worktreeToDelete.branch),
    async () => {
      const cmd = new DeleteWorktreeCommand(
        services.worktree,
        services.containerRuntime,
        services.git,
        services.tmux,
        repoForDelete,
        worktreeToDelete,
        hasWarnings ?? false,
      )
      const result = await cmd.execute()
      if (result.success) {
        dispatch({ type: "SET_STATUS", message: result.message })
        setWorktreeIndex(0)
        await handleRefresh({ quiet: true })
      } else {
        dispatch({ type: "SET_ERROR", message: result.message })
      }
    },
  )
}, [/* deps */])
```

**Important note on captured state:** The current `handleConfirmDelete` captures `state.selectedRepo` and `state.safetyWorktree` from the closure. After `CLOSE_DIALOG` dispatch, the reducer clears `safetyWorktree` to `null`. Since React batches state updates and the callback runs synchronously, the captured values should still be valid. However, to be safe, **snapshot the values before dispatching CLOSE_DIALOG** (as shown above with `worktreeToDelete` and `repoForDelete`).

**Acceptance criteria:**
- [ ] Delete operations show a spinner in ActivityOverlay
- [ ] Dialog dismisses before spinner appears
- [ ] Typecheck passes

---

### Task 6: Ensure UI flushes before blocking work — yield to renderer
**Complexity:** High (core fix)  
**Dependencies:** Requires Tasks 1-5  
**Files:** `tui/src/utils/activity.ts`

**What to do:**

This is the **key fix**. Even with async git methods, `Bun.spawn` still takes time to start and the `await` may not yield to React's renderer immediately. We need to ensure that after dispatching `BEGIN_ACTIVITY`, React has a chance to flush the UI update to the terminal before the operation starts.

**Modify `createActivityTracker` to insert a yield between dispatch and operation:**

```typescript
export function createActivityTracker({
  dispatch,
  createId = createActivityId,
  now = () => new Date(),
}: CreateActivityTrackerOptions) {
  return async function trackActivity<TResult>(
    activity: ActivityDraft,
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    const activeOperation: ActiveOperation = {
      ...activity,
      id: createId(),
      startedAt: now(),
    }

    dispatch({ type: "BEGIN_ACTIVITY", activity: activeOperation })

    // Yield to allow React to flush the UI update (dismiss dialog, show spinner)
    // before starting potentially blocking work.
    await yieldToRenderer()

    try {
      return await operation()
    } finally {
      dispatch({ type: "END_ACTIVITY", id: activeOperation.id })
    }
  }
}

/**
 * Yield control to the event loop so React can process pending state
 * updates and the OpenTUI renderer can flush changes to the terminal.
 *
 * Uses setTimeout(0) rather than queueMicrotask because microtasks
 * run before the event loop processes I/O and timer callbacks,
 * which means React's commit phase (which uses MessageChannel or
 * setTimeout internally) may not have run yet.
 */
function yieldToRenderer(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
```

**Why `setTimeout(0)` and not `queueMicrotask`:**
- `queueMicrotask` runs before the event loop yields to I/O. React 19's batching uses scheduler primitives that may rely on MessageChannel or setTimeout.
- `setTimeout(0)` guarantees at least one event loop turn, giving React's scheduler a chance to process the pending dispatch and flush to the renderer.
- In practice, this adds ~1ms delay which is imperceptible but ensures the terminal shows the updated UI.

**Acceptance criteria:**
- [ ] After pressing Enter in InputDialog, the dialog visually disappears *before* the git operation starts
- [ ] The ActivityOverlay spinner appears *before* the git operation starts
- [ ] Same behavior for delete confirmation dialog
- [ ] No segfaults from repeated Enter presses

---

### Task 7: Prevent duplicate command execution from rapid keypresses
**Complexity:** Medium  
**Dependencies:** Requires Task 6  
**Files:** `tui/src/components/InputDialog.tsx`, `tui/src/components/Dialog.tsx`

**What to do:**

Even with the yield fix, a user could still press Enter twice quickly before the dialog unmounts. Add a `submittedRef` guard to both dialog components.

**InputDialog.tsx:**
```typescript
import { useCallback, useRef, useState } from "react"

export function InputDialog({ title, placeholder, onSubmit, onCancel }: InputDialogProps) {
  const [value, setValue] = useState("")
  const submittedRef = useRef(false)

  const handleSubmit = useCallback(() => {
    if (submittedRef.current) return
    const trimmed = value.trim()
    if (trimmed) {
      submittedRef.current = true
      onSubmit(trimmed)
    }
  }, [value, onSubmit])

  useKeyboard((key) => {
    if (submittedRef.current) return    // <-- guard
    if (key.name === "enter" || key.name === "return") {
      handleSubmit()
    } else if (key.name === "escape") {
      onCancel()
    }
  })

  // ... rest unchanged
}
```

**Dialog.tsx:**
```typescript
import { useRef } from "react"

export function Dialog({ title, message, onConfirm, onCancel, ... }: DialogProps) {
  const confirmedRef = useRef(false)

  useKeyboard((key) => {
    if (confirmedRef.current) return    // <-- guard
    if (key.name === "enter" || key.name === "return") {
      confirmedRef.current = true
      onConfirm()
    } else if (key.name === "escape") {
      onCancel()
    }
  })

  // ... rest unchanged
}
```

**Why `useRef` instead of state?** A `useState` setter would trigger a re-render, and the keyboard handler closure might still reference the old value due to stale closure. `useRef` is synchronously readable and doesn't trigger re-renders.

**Acceptance criteria:**
- [ ] Pressing Enter 5 times rapidly in InputDialog only triggers `onSubmit` once
- [ ] Pressing Enter 5 times rapidly in Dialog only triggers `onConfirm` once
- [ ] No segfault from rapid keypresses
- [ ] Typecheck passes

---

### Task 8: Optimistic UI for create — dismiss dialog synchronously in the same dispatch batch
**Complexity:** Low  
**Dependencies:** Requires Task 6  
**Files:** `tui/src/App.tsx`

**What to do:**

The current `handleCreateWorktree` already dispatches `SET_INPUT_MODE: "none"` before `trackActivity`. This is correct. However, verify the ordering is right and that no other code path could re-set `inputMode` before the yield.

Review and confirm this sequence in `handleCreateWorktree`:
1. `dispatch({ type: "SET_INPUT_MODE", mode: "none" })` — dismiss dialog
2. `await trackActivity(activity, async () => { ... })` — BEGIN_ACTIVITY dispatch + yield + execute

The `trackActivity` now yields after BEGIN_ACTIVITY (from Task 6), so the sequence of dispatches before yield is:
1. `SET_INPUT_MODE: "none"` (dialog dismiss)
2. `BEGIN_ACTIVITY` (spinner show)
3. *yield* — React flushes both updates
4. Execute command

This is exactly the desired behavior. **No change needed** to `handleCreateWorktree` if Tasks 5-6 are implemented correctly. But verify during testing.

**Acceptance criteria:**
- [ ] Create worktree flow: Enter -> dialog disappears -> spinner shows -> command runs -> spinner disappears -> worktree appears in list
- [ ] Manual test confirms responsive feel

---

### Task 9: Optimistic UI for delete — ensure CLOSE_DIALOG happens before trackActivity
**Complexity:** Low  
**Dependencies:** Requires Tasks 5, 6  
**Files:** `tui/src/App.tsx`

**What to do:**

With Task 5's changes, `handleConfirmDelete` now:
1. Dispatches `CLOSE_DIALOG` (dismiss dialog)
2. Captures state values to locals
3. Calls `trackActivity(...)` which dispatches `BEGIN_ACTIVITY` + yields

Verify the full sequence:
1. `CLOSE_DIALOG` dispatch (dialog dismiss)
2. `BEGIN_ACTIVITY` dispatch (spinner show)
3. *yield* — React flushes both
4. Execute DeleteWorktreeCommand
5. On success: `SET_STATUS` + refresh
6. `END_ACTIVITY` (spinner dismiss)

This is the correct order. The key risk is that after `CLOSE_DIALOG`, the reducer sets `safetyWorktree: null`. If the callback accesses `state.safetyWorktree` after the yield, it would be null. **Task 5 already handles this by snapshotting values before dispatch.** Verify this during implementation.

**Acceptance criteria:**
- [ ] Delete worktree flow: Enter -> dialog disappears -> spinner shows "Deleting worktree X..." -> command runs -> spinner disappears -> worktree removed from list
- [ ] Manual test confirms responsive feel

---

### Task 10: Make TmuxService methods async in the delete path
**Complexity:** Low  
**Dependencies:** Requires Task 1 pattern  
**Files:** `tui/src/services/TmuxService.ts`, `tui/src/commands/DeleteWorktreeCommand.ts`

**What to do:**

`DeleteWorktreeCommand.execute()` also calls sync methods on `TmuxService`:
- `this.tmuxService.hasSession(worktree.tmuxSession)` — `Bun.spawnSync`
- `this.tmuxService.killSession(worktree.tmuxSession)` — `Bun.spawnSync`

These should also be async to avoid blocking.

Read `TmuxService.ts` first to see the methods, then add async versions:

```typescript
async hasSessionAsync(name: string): Promise<boolean> {
  const result = await exec("tmux", ["has-session", "-t", name])
  return result.success
}

async killSessionAsync(name: string): Promise<void> {
  await exec("tmux", ["kill-session", "-t", name])
}
```

Then update `DeleteWorktreeCommand.execute()`:
```typescript
// Before:
if (this.tmuxService.hasSession(this.worktree.tmuxSession)) {
  try { this.tmuxService.killSession(this.worktree.tmuxSession) } catch { }
}

// After:
if (await this.tmuxService.hasSessionAsync(this.worktree.tmuxSession)) {
  try { await this.tmuxService.killSessionAsync(this.worktree.tmuxSession) } catch { }
}
```

**Acceptance criteria:**
- [ ] No sync `Bun.spawnSync` calls remain in the delete execution path
- [ ] Typecheck passes

---

### Task 11: Lint, typecheck, and test
**Complexity:** Low  
**Dependencies:** Requires Tasks 1-10  
**Files:** All modified files

**What to do:**

Run the full validation suite from the `tui/` directory:

```bash
# Typecheck
bun run typecheck

# Lint
bun run lint

# Auto-fix lint issues
bun run lint:fix

# Run tests
bun test
```

Fix any issues found. Pay special attention to:
- Import type vs value imports (Biome's `useImportType` rule)
- Unused imports after refactoring
- Any test files that mock `GitService` sync methods — they may need to be updated to mock async versions too

**Acceptance criteria:**
- [ ] `bun run typecheck` exits 0
- [ ] `bun run lint` exits 0
- [ ] `bun test` — all tests pass

---

## Implementation Details

### Architecture Change: Sync vs Async Shell Execution

**Before (blocking):**
```
User presses Enter
  → dispatch(SET_INPUT_MODE: "none")        [queued, not flushed]
  → dispatch(BEGIN_ACTIVITY)                [queued, not flushed]
  → Bun.spawnSync("git", ["rev-parse"...])  [BLOCKS 50ms]
  → Bun.spawnSync("git", ["rev-list"...])   [BLOCKS 30ms]
  → Bun.spawnSync("git", ["log"...])        [BLOCKS 40ms]
  → Bun.spawnSync("git", ["branch"...])     [BLOCKS 30ms]
  → Bun.spawnSync("git", ["worktree add"])  [BLOCKS 200ms]
  → dispatch(SET_STATUS)
  → dispatch(END_ACTIVITY)
  → React finally flushes ALL pending updates
  [Total UI freeze: ~350ms — dialog visible the whole time]
```

**After (async + yield):**
```
User presses Enter
  → dispatch(SET_INPUT_MODE: "none")        [queued]
  → dispatch(BEGIN_ACTIVITY)                [queued]
  → await setTimeout(0)                     [YIELDS — React flushes!]
  → [Dialog disappears, spinner appears]    [User sees immediate feedback]
  → await Bun.spawn("git", ["rev-parse"])   [non-blocking, 50ms]
  → await Bun.spawn("git", ["rev-list"])    [non-blocking, 30ms]
  → ...etc...
  → dispatch(SET_STATUS)
  → dispatch(END_ACTIVITY)
  [Total time same, but UI responsive throughout]
```

### Key Pattern: Async Git Method

Every async git method follows this template:

```typescript
// In GitService.ts
async methodNameAsync(repoPath: string, ...args): Promise<ReturnType> {
  const result = await exec("git", ["-C", repoPath, ...gitArgs])
  if (!result.success) {
    throw new Error(`git <command> failed: ${result.stderr}`)
  }
  return parseResult(result.stdout)
}
```

Where `exec` is the existing async function from `tui/src/utils/shell.ts:55` that uses `Bun.spawn`.

### Key Pattern: Duplicate Submit Guard

```typescript
const submittedRef = useRef(false)

useKeyboard((key) => {
  if (submittedRef.current) return
  if (key.name === "enter" || key.name === "return") {
    submittedRef.current = true
    onSubmit(value)
  }
})
```

### Gotchas and Edge Cases

1. **Stale closure after dialog dismiss.** After `CLOSE_DIALOG` dispatch, the reducer sets `safetyWorktree: null`. If `handleConfirmDelete` accesses `state.safetyWorktree` *after* the yield, it gets null. **Fix:** Capture to local variables before dispatching.

2. **TmuxService.hasSession on macOS.** If tmux is not installed, `Bun.spawn("tmux", ...)` will reject. The existing try/catch handles this, but make sure the async version also catches.

3. **StatusService.compute() still uses sync.** This is intentionally left sync for now. It's called during `handleRefresh()` which already runs inside `trackActivity`, so the spinner is visible. Converting this is a separate optimization.

4. **Test mocks.** Existing tests mock `GitService` methods directly. If tests call `gitService.worktreeAdd`, they need to also handle `gitService.worktreeAddAsync`. Check each test file.

5. **`exec` function in shell.ts.** The existing `exec` function reads stdout/stderr via `new Response(proc.stdout).text()`. This is Bun's way of reading streams. It works correctly but if the git process produces large output, it could be slow. For our use case (small outputs), it's fine.

6. **React 19 batching.** React 19 batches all state updates within the same synchronous call stack. So `SET_INPUT_MODE` + `BEGIN_ACTIVITY` dispatched before the yield will be batched into a single render. This is optimal — one render to show "dialog gone + spinner visible".

## Testing Strategy

### Unit Tests to Update

| Test File | Changes Needed |
|-----------|---------------|
| `tui/src/__tests__/commands/DeleteWorktreeCommand.test.ts` | Update mocks for async git methods (`isMergedAsync`, `deleteBranchAsync`), async tmux methods |
| `tui/src/__tests__/services/WorktreeService.test.ts` | Update mocks for `worktreeAddAsync`, `worktreeRemoveAsync`, `worktreeListAsync`, `worktreePruneAsync` |

### New Unit Tests to Write

| Test | What It Verifies |
|------|-----------------|
| `GitService.worktreeAddAsync` | Returns void on success, throws on failure |
| `GitService.getBranchInfoAsync` | Returns correct BranchInfo, handles missing branch |
| `activity.ts: trackActivity yields` | Verify BEGIN_ACTIVITY dispatch happens before operation starts |

### Manual Testing Steps

1. **Create worktree — happy path:**
   - Press `n`, type a branch name, press Enter
   - **Expected:** Dialog disappears instantly, spinner appears in top-right saying "Creating worktree X...", worktree appears in list when done, spinner disappears
   - **Verify:** No perceptible delay between Enter and dialog dismiss

2. **Create worktree + container — happy path:**
   - Press `N`, type a branch name, press Enter
   - **Expected:** Dialog disappears instantly, spinner appears saying "Creating worktree and starting container for X...", takes longer (Docker build) but UI stays responsive

3. **Delete worktree — happy path:**
   - Select a worktree, press `d`, see confirmation dialog, press Enter
   - **Expected:** Dialog disappears instantly, spinner appears saying "Deleting worktree X...", worktree removed from list when done

4. **Rapid Enter presses — stress test:**
   - Press `n`, type a branch, press Enter 10 times rapidly
   - **Expected:** Only one worktree created, no crash, no duplicate spinners

5. **Delete with container — happy path:**
   - Select a worktree that has a running container, press `d`, confirm
   - **Expected:** Dialog disappears, spinner shows, container + network + volumes removed, worktree removed

6. **Error case — create with existing branch:**
   - Press `n`, type an existing branch name, press Enter
   - **Expected:** Dialog disappears, spinner appears briefly, error message shown in status bar

### Verification Commands

```bash
# From tui/ directory:

# TypeScript type checking
bun run typecheck

# Linting (Biome)
bun run lint

# Auto-fix lint issues
bun run lint:fix

# Run all tests
bun test

# Run specific test file
bun test src/__tests__/commands/DeleteWorktreeCommand.test.ts
bun test src/__tests__/services/WorktreeService.test.ts

# Start TUI for manual testing
bun run start
```

## Definition of Done

- [ ] All 11 subtasks completed
- [ ] `bun run typecheck` passes with 0 errors
- [ ] `bun run lint` passes with 0 errors
- [ ] `bun test` — all tests pass
- [ ] Manual test: Create worktree shows instant dialog dismiss + spinner
- [ ] Manual test: Delete worktree shows instant dialog dismiss + spinner  
- [ ] Manual test: Rapid Enter presses do not cause crash or duplicate operations
- [ ] No `Bun.spawnSync` calls remain in the create or delete execution paths (from dispatch through command completion)
- [ ] Code follows project conventions (Biome, TypeScript strict, named exports, JSDoc)
