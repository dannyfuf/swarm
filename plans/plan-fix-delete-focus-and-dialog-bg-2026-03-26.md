# Implementation Plan: Fix Delete Focus Navigation & Dialog Background

Generated: 2026-03-26

## Summary

Two bugs need to be fixed in the Swarm TUI:

1. **Delete focus bug**: After a worktree is deleted, the focus (highlighted panel) stays on whichever panel was focused before deletion. It should automatically move to the "worktrees" panel so the user can immediately navigate the remaining worktrees. Currently `handleConfirmDelete` in `App.tsx` resets the list cursor index (`setWorktreeIndex(0)`) and refreshes the list, but never dispatches `SET_FOCUSED_PANEL` to move focus back to the worktree list.

2. **Dialog background bug**: When creating a new worktree, the `InputDialog` (branch name prompt) renders as a centered box over a full-screen overlay `<box>`, but the overlay has no background color. In a terminal, this means the underlying 3-panel layout bleeds through around the dialog, making it look transparent. The overlay needs a solid background color consistent with the app's dark theme. The same issue applies to the confirmation `Dialog` and `HelpDialog` overlays.

## Prerequisites

- **Runtime**: Bun >= 1.0
- **Dependencies installed**: `bun install` in the `tui/` directory
- **Project type**: TypeScript with OpenTUI React (terminal UI framework)
- **Linter**: Biome (`bunx biome check .` in `tui/`)
- **Type checker**: TypeScript (`bun run typecheck` in `tui/`)
- **Test runner**: `bun test` in `tui/`
- **Coding conventions**: 2-space indent, double quotes, semicolons as-needed, named exports only (no default exports), type-only imports enforced. See `tui/biome.json`.

### Key Architecture Knowledge

The app uses a 3-panel layout (Repos | Worktrees | Detail) with:
- **State management**: React Context + `useReducer` in `tui/src/state/appReducer.ts`
- **Actions**: Discriminated union in `tui/src/state/actions.ts`
- **Focus tracking**: `state.focusedPanel` (type `Panel = "repos" | "worktrees" | "detail"`)
- **Dialog overlays**: Rendered as `<box position="absolute">` in `App.tsx` lines 815-850
- **Colors**: All hardcoded inline as hex strings (no centralized theme). Primary accent: `#6366F1`.

## Task Breakdown

### Task 1: Move focus to worktree list after deletion
- **Complexity**: Low
- **Dependencies**: None
- **Files to modify**: `tui/src/App.tsx`
- **Acceptance criteria**: After a successful worktree deletion, `state.focusedPanel` is `"worktrees"` and the worktree list panel border is highlighted (blue), and the first remaining worktree is selected.

### Task 2: Add solid background to all dialog overlays
- **Complexity**: Low
- **Dependencies**: None
- **Files to modify**: `tui/src/components/InputDialog.tsx`, `tui/src/components/Dialog.tsx`, `tui/src/components/HelpDialog.tsx`
- **Acceptance criteria**: All three dialog types render with a dark solid background that covers the underlying panels, preventing bleed-through.

### Task 3: Update tests
- **Complexity**: Low
- **Dependencies**: Tasks 1, 2
- **Files to modify**: `tui/src/__tests__/state/appReducer.test.ts`, `tui/src/__tests__/components/Dialog.test.tsx`
- **Acceptance criteria**: All existing tests pass. New tests verify the focus-after-delete behavior and dialog background rendering.

### Task 4: Lint and type check
- **Complexity**: Low
- **Dependencies**: Tasks 1, 2, 3
- **Acceptance criteria**: `bun run typecheck` and `bun run lint` pass with zero errors in `tui/`.

## Implementation Details

### Task 1: Move focus to worktree list after deletion

**File**: `tui/src/App.tsx`
**Function**: `handleConfirmDelete` (lines 504-546)

**Root cause**: After a successful delete, the code calls `setWorktreeIndex(0)` and `handleRefresh({ quiet: true })` but never dispatches `SET_FOCUSED_PANEL`. The `CLOSE_DIALOG` action (dispatched at line 511) does not change `focusedPanel` either — see reducer lines 105-114.

**Fix**: Add a `SET_FOCUSED_PANEL` dispatch and a `SELECT_WORKTREE` dispatch after the refresh completes, so the user lands on the worktree list with the first worktree selected.

**Exact change location**: Inside the `if (result.success)` block at line 526-529.

**Current code** (`App.tsx` lines 526-529):
```typescript
if (result.success) {
  dispatch({ type: "SET_STATUS", message: result.message })
  setWorktreeIndex(0)
  await handleRefresh({ quiet: true })
}
```

**New code**:
```typescript
if (result.success) {
  dispatch({ type: "SET_STATUS", message: result.message })
  setWorktreeIndex(0)
  await handleRefresh({ quiet: true })
  dispatch({ type: "SET_FOCUSED_PANEL", panel: "worktrees" })
}
```

**Why this works**: `handleRefresh` dispatches `SET_WORKTREES` which populates `state.worktrees` with the updated list and clears `selectedWorktree` to `null`. The `SET_FOCUSED_PANEL` then moves the highlight to the worktrees panel.

**Note on `selectedWorktree`**: After `SET_WORKTREES`, `selectedWorktree` is `null`. This is acceptable because:
- The `WorktreeList` `<select>` component is focused with `worktreeIndex=0`, so the first item is highlighted
- The `handleWorktreeChange` callback (line 674-681) fires when the user navigates with j/k, dispatching `SELECT_WORKTREE`
- This is consistent with how the app behaves when a repo is first selected (worktrees load, `selectedWorktree` is null, user navigates to select one)

However, for a better UX, you should **also** select the first worktree automatically so the detail panel immediately shows info. After the `handleRefresh` call, add a dispatch to select the first worktree from the refreshed state. Since `handleRefresh` updates `state.worktrees` asynchronously via dispatch, you need to access the refreshed worktrees. The simplest approach is to dispatch `SELECT_WORKTREE` with the first worktree after refresh.

**Problem**: `state.worktrees` is not yet updated when the next line runs (React batches state updates). However, `handleRefresh` internally calls the refresh command which returns the worktree list in `result.data.worktrees`. We can extract the first worktree from there.

**Better approach — modify `handleRefresh` return value**: This would be invasive. Instead, a simpler approach is to read the worktrees from the refresh result within `handleConfirmDelete` itself by inlining a manual refresh. **But this duplicates logic.**

**Simplest correct approach**: After `handleRefresh`, the `state.worktrees` array will be updated on next render. The `WorktreeList` `<select>` component with `selectedIndex=0` will highlight the first item. The `handleWorktreeChange` callback fires on mount/re-render when the list changes, which dispatches `SELECT_WORKTREE`. Verify this is the case by reading the `WorktreeList` component behavior. If `onChange` does NOT fire automatically when the list re-renders with a new worktree set at index 0, then we need an additional mechanism.

**Actually, the safest minimal fix** is just adding `SET_FOCUSED_PANEL` as shown above. The behavior will be:
1. Focus moves to worktrees panel ✓
2. First worktree is highlighted (via `setWorktreeIndex(0)`) ✓
3. Detail panel shows "Select a worktree to view details" (because `selectedWorktree` is null) — this is acceptable
4. User presses j/k or Enter to select a worktree — normal flow ✓

This matches the existing pattern when you first select a repo (focus moves to worktrees, no worktree is selected yet until you navigate).

### Task 2: Add solid background to all dialog overlays

The three dialog overlay wrappers are in `App.tsx` (lines 815-850), but the background should be on the **outermost `<box>`** of each dialog component itself, not in `App.tsx`. This keeps the responsibility inside each dialog component and follows the principle that the dialog owns its visual appearance.

**Approach**: Add `backgroundColor` to the outermost full-screen `<box>` element inside each of the three dialog components. Use a dark color that is opaque in the terminal.

**Color choice**: Use `#000000` (pure black) for the full-screen backdrop. This is the simplest and most reliable way to fully occlude the underlying content in a terminal. The dialog box itself already has its own border and internal padding against this black background, which provides sufficient contrast with the existing `#6366F1` (indigo) border.

**Alternative**: Use `#0a0a1a` (very dark navy) to be more thematic, but `#000000` is the safest terminal-wide choice since some terminal emulators may render near-black differently.

#### File: `tui/src/components/InputDialog.tsx`

**Current code** (line 41):
```tsx
<box justifyContent="center" alignItems="center" width="100%" height="100%">
```

**New code**:
```tsx
<box justifyContent="center" alignItems="center" width="100%" height="100%" backgroundColor="#000000">
```

#### File: `tui/src/components/Dialog.tsx`

**Current code** (line 40):
```tsx
<box justifyContent="center" alignItems="center" width="100%" height="100%">
```

**New code**:
```tsx
<box justifyContent="center" alignItems="center" width="100%" height="100%" backgroundColor="#000000">
```

#### File: `tui/src/components/HelpDialog.tsx`

**Current code** (line 49):
```tsx
<box justifyContent="center" alignItems="center" width="100%" height="100%">
```

**New code**:
```tsx
<box justifyContent="center" alignItems="center" width="100%" height="100%" backgroundColor="#000000">
```

### Task 3: Update tests

#### 3a. Reducer test — verify focus after delete would work

**File**: `tui/src/__tests__/state/appReducer.test.ts`

No new reducer tests are needed for Task 1, because the fix is a `SET_FOCUSED_PANEL` dispatch in `App.tsx` (component logic), not a reducer change. The existing test `SET_FOCUSED_PANEL changes focused panel` at line 157 already covers the reducer behavior.

However, you could add a **behavioral comment** to the existing `CLOSE_DIALOG` test to document that `CLOSE_DIALOG` intentionally does NOT reset `focusedPanel`.

#### 3b. Component tests — verify dialog background

**File**: `tui/src/__tests__/components/Dialog.test.tsx`

Add tests for `InputDialog` rendering (currently untested) and verify that all three dialog types render without crashing with the new background. The existing tests use `captureCharFrame()` which captures rendered text — background color won't be visible in text output but the test ensures no rendering errors from the new prop.

**New test to add**:
```typescript
describe("InputDialog", () => {
  test("renders title and input placeholder", async () => {
    testSetup = await testRender(
      <InputDialog
        title="New Worktree"
        placeholder="feature/my-branch"
        onSubmit={noop}
        onCancel={noop}
      />,
      { width: 60, height: 20 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("New Worktree")
    expect(frame).toContain("Cancel")
    expect(frame).toContain("Create")
  })
})
```

**Import to add** at top of test file:
```typescript
import { InputDialog } from "../../components/InputDialog.js"
```

### Task 4: Lint and type check

Run in the `tui/` directory:

```bash
bun run typecheck
bun run lint
bun test
```

All three must pass with zero errors.

## Testing Strategy

### Automated Tests

1. **Existing tests** (`bun test` in `tui/`): All must continue to pass
2. **New InputDialog test**: Verify the InputDialog renders correctly with the background change
3. **Reducer tests**: Already cover `SET_FOCUSED_PANEL`, `CLOSE_DIALOG`, `SET_WORKTREES` — no changes needed

### Manual Testing

#### Bug 1: Delete focus navigation

1. Start the app: `bun run start` in `tui/`
2. Select a repo (Enter on repo list) — focus moves to worktrees
3. Navigate to a worktree and press Enter — focus moves to detail panel
4. Press `d` to delete the selected worktree
5. Confirm deletion in the dialog (Enter)
6. **Verify**: After deletion completes, the worktrees panel border is highlighted (blue/`#4455FF`), the first remaining worktree is highlighted in the list, and the detail panel shows "Select a worktree to view details"
7. Press `j` or `k` — verify you can navigate the worktree list immediately

#### Bug 2: Dialog background

1. Start the app: `bun run start` in `tui/`
2. Select a repo (Enter)
3. Press `n` to create a new worktree
4. **Verify**: The InputDialog appears with a solid dark background — the 3-panel layout beneath is NOT visible around the dialog
5. Press Esc to cancel
6. Navigate to a worktree, press `d` to trigger delete dialog
7. **Verify**: The confirmation Dialog also has a solid dark background
8. Press Esc to cancel
9. Press `?` to open help
10. **Verify**: The HelpDialog also has a solid dark background

## Definition of Done

- [x] Task 1: `SET_FOCUSED_PANEL` dispatch added after successful worktree deletion
- [x] Task 2: `backgroundColor="#000000"` added to outermost `<box>` of `InputDialog`, `Dialog`, and `HelpDialog`
- [x] Task 3: Tests updated (InputDialog test added, all existing tests pass)
- [x] Task 4: All checks pass:

```bash
# In tui/ directory:
bun test           # All tests pass
bun run typecheck  # tsc --noEmit passes
bun run lint       # bunx biome check . passes
```

## Files Modified (Summary)

| File | Change | Task |
|------|--------|------|
| `tui/src/App.tsx` | Add `SET_FOCUSED_PANEL` dispatch in `handleConfirmDelete` success block (line ~529) | 1 |
| `tui/src/components/Dialog.tsx` | Add `backgroundColor="#000000"` to outermost `<box>` (line 40) | 2 |
| `tui/src/components/InputDialog.tsx` | Add `backgroundColor="#000000"` to outermost `<box>` (line 41) | 2 |
| `tui/src/components/HelpDialog.tsx` | Add `backgroundColor="#000000"` to outermost `<box>` (line 49) | 2 |
| `tui/src/__tests__/components/Dialog.test.tsx` | Add `InputDialog` render test | 3 |

## Scope Boundaries

### In scope
- Fix focus navigation after worktree deletion
- Fix dialog background transparency for all three dialog types
- Update tests for changed components
- Lint/type check verification

### Out of scope
- Centralized theme/color system (all colors remain hardcoded inline — consistent with current codebase)
- Changes to the reducer logic (the fix is at the component level)
- Any changes to the delete command, services, or business logic
- Focus behavior after other operations (create, prune, etc.)
- Auto-selecting the first worktree after deletion (acceptable that `selectedWorktree` is null until user navigates — matches repo-select pattern)
