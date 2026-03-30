# Implementation Plan: Repo Worktree Selection And Tmux Layout Wiring
Generated: 2026-03-30

## Summary

The Swarm TUI has two regressions in its repo and worktree workflow. First, repo selection in the left panel is not driving the active repository state consistently, so the center worktree list can remain tied to the previous repo and new worktree creation can target the wrong repo. Second, tmux layout configuration is parsed into app config but never applied when opening a worktree session, so sessions always open with the default tmux layout instead of the configured one.

Affected areas:
- `tui/src/App.tsx`
- `tui/src/state/appReducer.ts`
- `tui/src/state/actions.ts`
- `tui/src/components/RepoList.tsx`
- `tui/src/components/WorktreeList.tsx`
- `tui/src/commands/CreateWorktreeCommand.ts`
- `tui/src/commands/CreateAndStartWorktreeCommand.ts`
- `tui/src/commands/OpenWorktreeCommand.ts`
- `tui/src/services/TmuxService.ts`
- `tui/src/services/ConfigService.ts`
- `tui/src/types/config.ts`
- `tui/src/index.tsx`
- `tui/src/__tests__/state/appReducer.test.ts`
- `tui/src/__tests__/commands/OpenWorktreeCommand.test.ts`
- `tui/src/__tests__/services/WorktreeService.test.ts`
- `tui/src/__tests__/components/RepoList.test.tsx`
- `tui/src/__tests__/components/WorktreeList.test.tsx`
- `README.md`

In scope:
- Fix repo selection so `selectedRepo`, the worktree list, and create/open actions all stay aligned.
- Ensure switching repos refreshes the worktree list and related derived state for the newly selected repo.
- Wire the existing `tmuxLayoutScript` config into tmux session creation/opening.
- Add or update automated tests covering both regressions.

Out of scope:
- Redesigning the TUI layout or changing keyboard semantics beyond what is necessary to make repo selection reliable.
- Adding new config keys or a new layout file format unless required to consume the already-documented `tmux_layout_script` option.
- Changing container workflow, git worktree path rules, or repo scanning behavior unrelated to selection sync.

## Prerequisites

- Project type: TypeScript app running on Bun, with OpenTUI React components.
- Install/runtime tools:
  - `bun`
  - `tmux >= 3.0`
  - `git`
- Useful commands from `tui/package.json`:
  - `bun test`
  - `bun run lint`
  - `bun run typecheck`
  - `bun run build`
- Relevant architecture to understand before editing:
  - `README.md:255-312` for project structure and commands.
  - `tui/src/App.tsx` for top-level orchestration of repo/worktree loading and command callbacks.
  - `tui/src/state/appReducer.ts` and `tui/src/state/actions.ts` for state transitions.
  - `tui/src/services/TmuxService.ts` for shell-wrapped tmux interactions.
  - `tui/src/commands/*.ts` for the command pattern used by UI actions.
- Configuration behavior to preserve:
  - `README.md:104-149` documents `tmux_layout_script` and `SWARM_TMUX_LAYOUT_SCRIPT`.
  - `tui/src/services/ConfigService.ts:81-157` already loads and normalizes the tmux layout script path.
- Existing conventions to follow:
  - Commands return `CommandResult` instead of throwing to the UI layer.
  - Services are thin wrappers over shell/filesystem behavior.
  - Tests use `bun:test` with `mock()` and small focused units.

## Task Breakdown

1. Confirm and document the repo-selection state mismatch.
   - Complexity: Low
   - Depends on: none
   - Acceptance criteria:
     - Identify the current mismatch between `repoIndex` and `state.selectedRepo` in `tui/src/App.tsx`.
     - Capture the exact flow causing create/refresh operations to use the wrong repo.

2. Make repo changes update the canonical selected repo immediately.
   - Complexity: Medium
   - Depends on: #1
   - Acceptance criteria:
     - Navigating to a different repo updates `state.selectedRepo` without requiring a second confirmation path that can drift from the visible highlight.
     - Worktree refresh uses the newly selected repo every time.
     - Creating a worktree after switching repos targets the highlighted repo, not the first repo in the list.

3. Reset dependent worktree/detail state when repo selection changes.
   - Complexity: Medium
   - Depends on: #2
   - Acceptance criteria:
     - Changing repos clears stale worktree selection and any repo-scoped derived state that should not linger.
     - The center panel displays worktrees for the new repo, or the empty state if none exist.
     - No stale statuses or detail pane content remain associated with the previous repo.

4. Implement tmux layout application in the session open/create path.
   - Complexity: Medium
   - Depends on: none
   - Acceptance criteria:
     - When `tmuxLayoutScript` is configured and a session is created/opened, the layout is applied before attach/switch.
     - When no layout script is configured, existing behavior remains unchanged.
     - Failures from layout application surface clearly through the existing command result path.

5. Add regression tests for repo selection and tmux layout wiring.
   - Complexity: Medium
   - Depends on: #2, #3, #4
   - Acceptance criteria:
     - Tests fail before the fix and pass after it.
     - There is coverage for repo switch -> worktree refresh behavior and for open-session layout application behavior.

6. Run verification and update docs if behavior or expectations changed.
   - Complexity: Low
   - Depends on: #5
   - Acceptance criteria:
     - `bun test`, `bun run lint`, and `bun run typecheck` pass.
     - `README.md` is updated if needed to clarify when the tmux layout script is applied.

## Implementation Details

### 1. Repo selection state mismatch

Files to inspect:
- `tui/src/App.tsx`
- `tui/src/state/appReducer.ts`
- `tui/src/state/actions.ts`

Current code pattern:
- `tui/src/App.tsx:726-737` updates `repoIndex` in `handleRepoChange`, but only dispatches `SELECT_REPO` in `handleRepoSelect`.
- `tui/src/App.tsx:140-146` reloads worktrees only when `state.selectedRepo` changes.
- `tui/src/App.tsx:237-276` creates worktrees using `state.selectedRepo` captured inside `handleCreateWorktree`.

Why this matters:
- The visible selection in the repo list can move independently from `state.selectedRepo`.
- If the user navigates to a repo but does not trigger the exact callback path that dispatches `SELECT_REPO`, the UI looks switched while commands still operate on the old repo.

Recommended implementation approach:
- Choose a single source of truth for repo selection.
- Prefer making repo navigation update `state.selectedRepo` in `handleRepoChange`, not only in `handleRepoSelect`.
- Keep `repoIndex` as UI state only if needed by OpenTUI's `<select>` component, but derive it from `state.selectedRepo` or update both together in the same handler.
- If reducer support is needed, consider making `SELECT_REPO` also clear repo-scoped dependent state in one place instead of relying on separate effects.

Potential gotchas:
- Avoid double-dispatch loops where changing `repoIndex` triggers `selectedRepo`, which then forces `repoIndex` again.
- Preserve current panel focus behavior if Enter is still supposed to move focus to `worktrees`.
- Make sure asynchronous callbacks do not keep using a stale `selectedRepo` captured before the switch.

### 2. Refresh worktree and detail state on repo changes

Files to modify:
- `tui/src/App.tsx`
- `tui/src/state/appReducer.ts`
- Possibly `tui/src/state/actions.ts`

Existing code patterns to follow:
- `tui/src/App.tsx:81-114` `loadWorktrees` fetches worktrees, statuses, and container statuses together.
- `tui/src/App.tsx:148-180` container config summary already uses a cancellation guard keyed by repo path.
- `tui/src/state/appReducer.ts:72-85` reducer already resets `selectedWorktree` on `SET_WORKTREES`.

Recommended implementation approach:
- On repo change, clear stale repo-scoped visual state before or while loading:
  - `worktrees`
  - `selectedWorktree`
  - `statuses`
  - `containerStatuses`
  - any repo-scoped detail summary if not already guarded by repo path
- If the reducer is updated, prefer a single action like `SELECT_REPO` or a new repo-change action to clear dependent state atomically.
- Review whether `loadWorktrees` should ignore out-of-order async responses if the user switches repos quickly, similar to the cancellation pattern already used for container config summary.

Strong candidate root cause to address:
- `loadWorktrees` reads `state.selectedRepo` from closure state. If repo changes happen quickly, an earlier async load can still dispatch results after a later switch. Add a cancellation or identity check so only the latest selected repo can commit worktree/status results.

Potential gotchas:
- Do not clear the repo list itself when switching repos.
- Avoid leaving `worktreeIndex` pointing at an index from the previous repo.
- Keep empty states stable when the new repo has zero worktrees.

### 3. Tmux layout wiring

Files to modify:
- `tui/src/services/TmuxService.ts`
- `tui/src/commands/OpenWorktreeCommand.ts`
- `tui/src/index.tsx`
- Possibly `tui/src/state/AppContext.tsx` only if constructor or service shape changes require it
- `README.md` if behavior needs clarifying

Current code pattern:
- `tui/src/services/ConfigService.ts:96-97,135-136` loads `tmuxLayoutScript`.
- `tui/src/index.tsx:32-39` constructs `TmuxService` with no config.
- `tui/src/commands/OpenWorktreeCommand.ts:24-31` creates a session if missing, then immediately attaches; no layout hook exists.
- `tui/src/services/TmuxService.ts:20-26` only runs `tmux new-session -d -s <name> -c <dir>`.

Recommended implementation approach:
- Extend `TmuxService` with an explicit layout application method instead of inlining shell logic in the command.
- Inject whichever config value is needed through constructor arguments or a dedicated method parameter.
- Apply layout only when:
  - the session is newly created, or
  - you intentionally want layout re-applied on every open
- Prefer the more conservative behavior unless product intent says otherwise: apply once on session creation, then attach.

Suggested design choice:
- Add a method like `createSession(name, workingDir, options?)` or `applyLayout(name, workingDir, layoutScript)`.
- Keep `OpenWorktreeCommand` responsible for orchestration and `TmuxService` responsible for tmux/shell execution.

Important decision to make explicit in code/comments:
- `README.md` says the config is a "custom tmux layout script (optional)" and `types/config.ts` says "shell or JSON", but no parser exists yet. Before implementing, confirm the expected contract.
- Most minimal option: treat `tmuxLayoutScript` as an executable script path and run it with context such as session name and worktree path.
- If JSON layout support is truly required, scope it explicitly; otherwise document that only executable scripts are supported for now.

Potential gotchas:
- The layout application must happen before `attachSession`, otherwise the user will see the default session before the layout runs.
- If the layout script fails, propagate a readable error message through `OpenWorktreeCommand.execute()`.
- Ensure paths with spaces are handled safely in tmux/script invocation.

### 4. Test coverage

Files to modify or add tests in:
- `tui/src/__tests__/state/appReducer.test.ts`
- `tui/src/__tests__/commands/OpenWorktreeCommand.test.ts`
- `tui/src/__tests__/components/RepoList.test.tsx`
- `tui/src/__tests__/components/WorktreeList.test.tsx`
- Add a focused `App` test only if reducer/handler extraction makes it practical; otherwise prefer unit tests around the reducer and command/service seams

Patterns to follow:
- `tui/src/__tests__/commands/OpenWorktreeCommand.test.ts` already mocks tmux and worktree services.
- `tui/src/__tests__/state/appReducer.test.ts` already verifies reducer transitions.
- `tui/src/__tests__/services/WorktreeService.test.ts` shows the preferred mocking style for services.

Recommended tests:
- Reducer/state tests:
  - selecting a repo resets `selectedWorktree`
  - selecting a repo clears stale `worktrees` and repo-scoped maps if reducer behavior is moved there
- Command tests:
  - opening a worktree with no existing session creates the session, applies layout, then attaches
  - opening a worktree with an existing session skips creation and either skips or preserves layout behavior per the chosen contract
  - layout script failure returns a failed `CommandResult`
- UI-level behavior tests if practical:
  - repo change handler updates active repo immediately on navigation, not only on confirmation

## Testing Strategy

Automated tests:
- Run unit tests for the touched areas first:
  - `cd /Users/danny/buk/swarm/tui && bun test`
- Run full linting:
  - `cd /Users/danny/buk/swarm/tui && bun run lint`
- Run type checking:
  - `cd /Users/danny/buk/swarm/tui && bun run typecheck`
- Optional final confidence check:
  - `cd /Users/danny/buk/swarm/tui && bun run build`

Manual validation steps:
1. Launch the app with at least two repos visible in the left panel.
2. Move the highlighted repo selection from the first repo to a different repo.
3. Confirm the center panel updates to show only the selected repo's worktrees.
4. With the second repo highlighted, create a new worktree using `n`.
5. Verify the new worktree is created under the selected repo's path and naming pattern, not under the first repo.
6. Switch back and forth between repos quickly and confirm the worktree list, detail pane, and statuses stay aligned with the currently highlighted/selected repo.
7. Configure `tmux_layout_script` in `~/.config/swarm/config.yaml` or set `SWARM_TMUX_LAYOUT_SCRIPT`.
8. Open a worktree with `o` and verify the tmux session comes up with the configured layout.
9. Repeat with an already-existing session and verify behavior matches the implemented contract.
10. Temporarily point `tmux_layout_script` to a failing script and verify the app reports a clear error instead of silently ignoring the failure.

End-to-end verification targets:
- The left-panel visible repo selection and `state.selectedRepo` always match.
- Repo switch immediately triggers a worktree reload for the new repo.
- Worktree creation, refresh, and open actions all operate on the same selected repo.
- Tmux layout configuration is observably applied in the session lifecycle.

## Definition of Done

- [ ] All subtasks completed
- [ ] Tests passing
- [ ] Code follows project conventions
- [ ] No linter or type offenses
- [ ] `bun test` passes in `tui/`
- [ ] `bun run lint` passes in `tui/`
- [ ] `bun run typecheck` passes in `tui/`
- [ ] Manual repo-switch and create-worktree regression checks pass
- [ ] Manual tmux layout verification passes
