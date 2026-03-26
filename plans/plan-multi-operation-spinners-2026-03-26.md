# Implementation Plan: Friendly Multi-Operation Spinners
Generated: 2026-03-26

## Summary

Add user-friendly loading indicators for long-running TUI actions, especially worktree creation and container build/start flows. The implementation should support more than one active spinner at a time so the UI can represent concurrent or overlapping background work without collapsing everything into a single status message.

This is a Bun + TypeScript + OpenTUI React project. The current app already has a global initial `loading` state for repository discovery in `tui/src/state/appReducer.ts`, but long-running commands in `tui/src/App.tsx` only update `statusMessage` after completion and do not expose in-progress activity.

- Affected areas:
  - `tui/src/App.tsx`
  - `tui/src/state/actions.ts`
  - `tui/src/state/appReducer.ts`
  - `tui/src/components/StatusBar.tsx`
  - `tui/src/components/DetailView.tsx`
  - `tui/src/__tests__/state/appReducer.test.ts`
  - `tui/src/__tests__/commands/StartContainerCommand.test.ts`
  - likely new UI/state files such as `tui/src/components/ActivityOverlay.tsx`, `tui/src/components/Spinner.tsx`, and `tui/src/hooks/useSpinnerFrames.ts`

- In scope:
  - Track long-running TUI operations as explicit state
  - Show one spinner row per active operation
  - Keep the initial full-screen loader for repository discovery
  - Add friendly operation labels for worktree/container actions
  - Ensure success and failure paths always clear the spinner

- Out of scope:
  - Streaming Docker build logs or percentage-complete progress bars
  - Changing non-TUI CLI output in `tui/src/cli/ContainerCli.ts`
  - Reworking command/service architecture beyond what is needed to expose activity state
  - Adding networked telemetry, persistence of spinner history, or retry queues

## Prerequisites

- Environment:
  - Bun >= 1.0
  - TypeScript toolchain from `tui/package.json`
  - Docker, Git, and tmux available for manual verification of real workflows

- Install and run:

```bash
cd tui
bun install
bun run start
```

- Read before coding:
  - `README.md` for feature flow, keyboard shortcuts, and architecture
  - `tui/src/App.tsx` for async action orchestration and panel layout
  - `tui/src/state/actions.ts` and `tui/src/state/appReducer.ts` for state conventions
  - `tui/src/commands/Command.ts` for the existing command contract
  - `tui/src/components/StatusBar.tsx` and `tui/src/components/DetailView.tsx` for current user feedback patterns

- Existing conventions to follow:
  - Keep command objects returning `Promise<CommandResult>` as in `tui/src/commands/Command.ts`
  - Keep state changes centralized in the reducer, following the pattern in `tui/src/state/appReducer.ts`
  - Use named exports only; `tui/biome.json` forbids default exports
  - Use project scripts for validation: `bun test`, `bun run lint`, `bun run typecheck`, `bun run build`

- OpenTUI guidance:
  - Reuse JSX primitives like `<box>` and `<text>` already used in `tui/src/App.tsx` and `tui/src/components/Panel.tsx`
  - Prefer a simple reusable spinner component/hook over ad hoc text updates in each handler

## Task Breakdown

1. Define an activity-tracking state model
   - Requires: none
   - Complexity: Medium
   - Files: `tui/src/state/actions.ts`, `tui/src/state/appReducer.ts`, optionally a new `tui/src/types/activity.ts`
   - Acceptance criteria:
     - App state can represent multiple simultaneous in-progress operations
     - Each tracked operation has enough metadata for UI copy, ordering, and cleanup
     - Reducer tests cover add/remove/clear behavior and do not regress initial `loading`

2. Add a reusable async activity wrapper in the app layer
   - Requires: #1
   - Complexity: Medium
   - Files: `tui/src/App.tsx`, optionally a new helper file such as `tui/src/utils/activity.ts`
   - Acceptance criteria:
     - Long-running handlers can register an activity before awaiting work and remove it in `finally`
     - Failure paths still clear activity state
     - The wrapper avoids duplicating begin/end logic across all handlers

3. Instrument long-running workflows with friendly labels
   - Requires: #2
   - Complexity: High
   - Files: `tui/src/App.tsx`
   - Acceptance criteria:
     - `handleCreateWorktree`, `handleStartContainer`, and `handleBuildContainerImage` show clear in-progress labels
     - Composite flow `CreateAndStartWorktreeCommand` is represented in a user-friendly way, ideally as one high-level action instead of noisy sub-steps
     - Any follow-up refresh/config reload work is either intentionally shown as background activity or intentionally suppressed with rationale

4. Build the spinner UI for concurrent activities
   - Requires: #1, #2
   - Complexity: Medium
   - Files: new `tui/src/components/ActivityOverlay.tsx`, new `tui/src/components/Spinner.tsx` or `tui/src/hooks/useSpinnerFrames.ts`, `tui/src/App.tsx`, `tui/src/components/StatusBar.tsx`
   - Acceptance criteria:
     - Multiple active operations render at the same time without overlapping critical UI
     - Spinner rows include concise labels and remain readable in narrow terminal widths
     - Status bar behavior remains sensible when errors, success messages, dialogs, and active work overlap

5. Add focused regression tests
   - Requires: #1, #2, #3
   - Complexity: Medium
   - Files: `tui/src/__tests__/state/appReducer.test.ts`, plus new tests for any extracted activity helper
   - Acceptance criteria:
     - Reducer tests validate multi-activity add/remove semantics
     - Helper tests verify cleanup on success and thrown errors
     - Existing command tests continue to pass without requiring command contract changes

6. Validate end-to-end behavior and developer ergonomics
   - Requires: #3, #4, #5
   - Complexity: Low
   - Files: none required unless fixes are discovered
   - Acceptance criteria:
     - Manual TUI flows visibly show spinners during real slow operations
     - Lint, typecheck, tests, and build all pass
     - UI remains navigable and understandable while background work is in progress

## Implementation Details

### 1. State Model And Boundaries

- Add an explicit `activeOperations` collection to app state rather than overloading `statusMessage`. `statusMessage` in `tui/src/state/appReducer.ts` is currently a single final-message channel, so it cannot represent concurrent work.
- Recommended shape for each activity:
  - `id`: unique operation id
  - `kind`: e.g. `create-worktree`, `create-and-start`, `start-container`, `build-container`, `refresh`
  - `label`: user-facing text
  - `scope`: repo/worktree identifier for deduping or filtering
  - `startedAt`: timestamp for stable ordering
  - optional `priority`: distinguish visible user actions from quieter background refreshes
- Follow the reducer/action pattern already used in `tui/src/state/actions.ts` and `tui/src/state/appReducer.ts:57`.
- Suggested actions:
  - `BEGIN_ACTIVITY`
  - `END_ACTIVITY`
  - optional `CLEAR_ACTIVITIES_FOR_SCOPE` if a worktree/repo switch needs cleanup
- Gotcha: do not replace the existing boolean `loading`; that flag still serves the initial full-screen loader in `tui/src/App.tsx:664`.

### 2. Activity Lifecycle In `App.tsx`

- Keep command classes unchanged where possible. The existing command contract in `tui/src/commands/Command.ts:10` is clean and should remain focused on success/failure results, not UI concerns.
- Extract a small helper in `tui/src/App.tsx` or a dedicated utility that wraps async work:
  - dispatch `BEGIN_ACTIVITY`
  - await the supplied async function
  - dispatch `END_ACTIVITY` in `finally`
- Use this helper in the same place current handlers already create commands and dispatch terminal status messages, such as:
  - `handleCreateWorktree` in `tui/src/App.tsx:204`
  - `handleStartContainer` in `tui/src/App.tsx:237`
  - `handleBuildContainerImage` in `tui/src/App.tsx:302`
  - optionally `handleRefresh` in `tui/src/App.tsx:177` if refreshes are slow enough to deserve a visible loader
- Gotcha: `handleCreateWorktree` often calls `handleRefresh()` on success. Decide whether refresh should appear as a second spinner or remain internal. Recommended default: treat user-triggered create/build/start as the visible operation and keep automatic refresh quiet unless it becomes materially slow.

### 3. Friendly Labels And Operation Mapping

- Use labels that explain outcome, not implementation details. Good examples:
  - `Creating worktree feature/foo...`
  - `Creating worktree and starting container for feature/foo...`
  - `Starting container for feature/foo...`
  - `Building container image for my-repo...`
- Build labels in `App.tsx`, where repo/worktree names are already available.
- Follow the current success-message style from:
  - `tui/src/commands/CreateWorktreeCommand.ts:34`
  - `tui/src/commands/StartContainerCommand.ts:28`
  - `tui/src/commands/BuildContainerImageCommand.ts:28`
- Gotcha: `CreateAndStartWorktreeCommand` in `tui/src/commands/CreateAndStartWorktreeCommand.ts:23` performs two expensive steps. Show one clear combined spinner unless you are prepared to support staged sub-status text.

### 4. Spinner Rendering Strategy

- Add a dedicated component, for example `tui/src/components/ActivityOverlay.tsx`, instead of pushing spinner text into `StatusBar` only. The bottom bar is one line tall in `tui/src/components/StatusBar.tsx:28`, so it cannot scale to multiple simultaneous activities.
- Recommended layout:
  - keep the existing full-screen initial loader for `state.loading`
  - render a compact activity stack near the bottom-right or top-right of the main app shell
  - show one row per activity with spinner glyph + label
  - cap visible rows and summarize overflow as `+N more tasks`
- A small reusable `Spinner` component or `useSpinnerFrames` hook is enough; no streamed progress bars are needed.
- Use simple animated frames such as `| / - \\` or unicode-safe equivalents only if the terminal rendering is already known to handle them well. ASCII is safest.
- Gotcha: the overlay must not block dialogs or input focus. Render it as a passive visual layer, similar to current absolute-position overlays in `tui/src/App.tsx:744`.

### 5. Detail Panel And Status Bar Integration

- Keep `StatusBar` as the place for errors, success messages, and key hints. Add only a compact aggregate message there when activities are running, for example `2 tasks running...`, if no error or success message is present.
- Do not force all spinner rows into the status bar; that would displace keyboard hints and make concurrency unreadable.
- Consider adding a lightweight hint to `tui/src/components/DetailView.tsx` when the selected worktree is the subject of an active operation, such as `Operation: starting container...`.
- Follow the current conditional rendering style in `tui/src/components/DetailView.tsx:96` and `tui/src/components/StatusBar.tsx:25`.
- Gotcha: background config-summary loads already render as `loading` in `tui/src/components/DetailView.tsx:40`. Do not create a second redundant spinner for the same tiny fetch unless it is intentionally part of the broader activity model.

### 6. Testing Guidance

- Primary tests should target reducer and helper logic because there is already solid state coverage in `tui/src/__tests__/state/appReducer.test.ts`.
- Add reducer cases for:
  - adding the first activity
  - adding a second concurrent activity
  - removing one activity while leaving another active
  - cleanup after errors
- If you extract an async wrapper helper, add unit tests for:
  - success path returns result and clears spinner
  - thrown error still clears spinner
  - nested/overlapping tracked operations produce multiple entries
- Existing command tests, like `tui/src/__tests__/commands/StartContainerCommand.test.ts`, should remain mostly unchanged if activity remains an app concern.
- Gotcha: do not overcouple tests to spinner frame timing. Test state and rendered labels, not animation ticks.

## Testing Strategy

- Automated checks:

```bash
cd tui
bun test
bun run lint
bun run typecheck
bun run build
```

- Unit tests to write or update:
  - `tui/src/__tests__/state/appReducer.test.ts` for new activity actions/state
  - new helper test file if activity lifecycle logic is extracted from `App.tsx`
  - optional component tests only if there is already a reliable OpenTUI renderer harness available; otherwise keep coverage focused on state and pure logic

- Manual TUI validation:
  1. Launch `bun run start` from `tui/` and confirm the existing initial `Loading repositories...` screen still works.
  2. Press `n` to create a worktree and verify a spinner appears immediately, stays visible until completion, then clears and shows the existing success/error message.
  3. Press `N` for create-and-start on a repo with valid container config and verify the label is understandable for the full composite workflow.
  4. Press `i` to build container images and verify the spinner remains visible during a real Docker build.
  5. Trigger overlapping work where possible, such as build plus automatic refresh, and verify multiple spinner rows render cleanly without overwriting each other.
  6. Test failure paths: missing container config, Docker unavailable, or invalid env file. Confirm the spinner disappears and the error/help dialog still appears.
  7. Resize the terminal to a narrow width and confirm labels truncate or wrap in a controlled way.

- End-to-end success criteria:
  - Users always get immediate feedback when a slow action starts
  - Multiple in-flight operations can be understood at a glance
  - Final success/error messages still appear after completion
  - No stuck spinner remains after an exception or cancelled flow

## Definition of Done

- [ ] All subtasks completed
- [ ] Tests passing
- [ ] Code follows project conventions
- [ ] No linter or type offenses
- [ ] `bun test` passes
- [ ] `bun run lint` passes
- [ ] `bun run typecheck` passes
- [ ] `bun run build` passes
- [ ] Initial repo loading still uses the full-screen loader
- [ ] Long-running worktree/container actions show friendly spinner text
- [ ] More than one concurrent spinner can be rendered without UI overlap
