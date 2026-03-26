# Implementation Plan: Worktree Deletion Cleanup
Generated: 2026-03-26

## Summary

Swarm currently leaves a deleted worktree visible in the worktree list in at least some cases, which makes it unclear whether the git worktree entry, on-disk directory, and attached Docker environment were actually cleaned up. The goal of this change is to make worktree deletion authoritative: deleting a worktree must remove the git worktree registration, remove only that worktree directory from disk, and tear down any associated container, network, and volumes so the entry disappears from the UI immediately after refresh.

### Context and Scope

Likely root cause and rationale:

- `tui/src/utils/git-parser.ts:24` currently parses `git worktree list --porcelain` without capturing stale metadata such as `prunable`
- `tui/src/services/WorktreeService.ts:85` treats every git-listed entry as an active worktree, so a stale admin entry can still render in the list even after the directory is gone
- `tui/src/services/WorktreeService.ts:142` removes git state and persisted state but does not explicitly verify that the worktree directory is gone or that the path no longer appears in `git worktree list`
- `tui/src/commands/DeleteWorktreeCommand.ts:27` removes Docker resources first, then delegates git/state cleanup, so partial failure handling needs to be explicit and test-covered

Affected files, modules, and directories:

- `tui/src/commands/DeleteWorktreeCommand.ts`
- `tui/src/services/WorktreeService.ts`
- `tui/src/services/GitService.ts`
- `tui/src/services/ContainerRuntimeService.ts`
- `tui/src/utils/git-parser.ts`
- `tui/src/types/git.ts`
- `tui/src/__tests__/utils/git-parser.test.ts`
- `tui/src/__tests__/services/ContainerRuntimeService.test.ts`
- New tests: `tui/src/__tests__/services/WorktreeService.test.ts`, `tui/src/__tests__/commands/DeleteWorktreeCommand.test.ts`
- Optional docs update: `README.md`

In scope:

- Fixing stale worktree entries that remain visible after deletion
- Ensuring delete flow removes the worktree directory but never the main repo
- Ensuring delete flow removes associated Docker container resources when metadata exists
- Verifying delete behavior through service, command, and parser tests
- Hardening refresh/list behavior so stale git admin entries do not look like valid worktrees

Out of scope:

- Changing worktree creation behavior
- Redesigning the TUI delete dialog beyond small message clarifications
- Deleting unmanaged Docker resources that are not tied to stored worktree metadata
- Changing repo discovery logic outside what is needed to keep deleted worktrees out of the list

## Prerequisites

### Environment setup

- Bun installed; install deps with `cd tui && bun install`
- Git available locally; deletion logic depends on `git worktree` behavior
- Docker running locally if validating container cleanup end-to-end
- A disposable test repo under the configured `aiWorkingDir` for manual delete-flow testing

### Project structure knowledge

- `tui/src/App.tsx:470` drives the delete confirmation and refresh flow
- `tui/src/commands/DeleteWorktreeCommand.ts:16` owns the high-level cleanup sequence
- `tui/src/services/WorktreeService.ts:85` builds the visible worktree list from git + persisted state
- `tui/src/services/WorktreeService.ts:142` is the main implementation point for git/state removal
- `tui/src/services/ContainerRuntimeService.ts:146` owns Docker environment teardown
- `tui/src/utils/git-parser.ts:24` is the parser boundary for `git worktree list --porcelain`

### Conventions to follow

- Keep shelling out to external tools inside services, not UI components; follow `tui/src/services/GitService.ts:16` and `tui/src/services/ContainerRuntimeService.ts:22`
- Keep user actions wrapped in command classes that return `CommandResult`; follow `tui/src/commands/StartContainerCommand.ts:12`
- Keep reducer/UI changes minimal unless required; `tui/src/App.tsx:504` already refreshes after delete success
- Add Bun tests beside the existing test suites under `tui/src/__tests__/`

### Background reading

- `README.md`
- Git docs for `git worktree list --porcelain`, `git worktree remove`, and `git worktree prune`
- Existing container behavior in `tui/src/services/ContainerRuntimeService.ts`

## Task Breakdown

1. Extend git worktree parsing to expose stale-entry signals
   - Depends on: none
   - Complexity: Low
   - Files: `tui/src/types/git.ts`, `tui/src/utils/git-parser.ts`, `tui/src/__tests__/utils/git-parser.test.ts`
   - Acceptance criteria: parsed worktree records can represent `prunable` or equivalent stale metadata from `git worktree list --porcelain`; tests cover active, detached, and stale/prunable entries

2. Harden worktree listing so deleted/stale entries do not render as active worktrees
   - Depends on: #1
   - Complexity: Medium
   - Files: `tui/src/services/WorktreeService.ts`, new `tui/src/__tests__/services/WorktreeService.test.ts`
   - Acceptance criteria: a git entry that is prunable or whose directory no longer exists is not returned as a normal active worktree; persisted state entries still behave correctly for real orphan cleanup scenarios

3. Make delete cleanup authoritative for git registration, filesystem directory, and persisted state
   - Depends on: #2
   - Complexity: High
   - Files: `tui/src/services/WorktreeService.ts`, `tui/src/services/GitService.ts`, `tui/src/commands/DeleteWorktreeCommand.ts`, new `tui/src/__tests__/commands/DeleteWorktreeCommand.test.ts`
   - Acceptance criteria: successful deletion guarantees the path no longer appears in `git worktree list`, the worktree directory is removed, `.swarm-state.json` no longer contains the worktree, and the main repo path is never eligible for deletion

4. Verify and harden container teardown behavior during delete
   - Depends on: #3
   - Complexity: Medium
   - Files: `tui/src/services/ContainerRuntimeService.ts`, `tui/src/__tests__/services/ContainerRuntimeService.test.ts`, `tui/src/commands/DeleteWorktreeCommand.ts`
   - Acceptance criteria: when `worktree.container` is present, delete removes container, network, and volumes idempotently; known "already gone" Docker errors do not block delete, but real Docker failures surface a clear error and do not silently claim success

5. End-to-end validation and small documentation cleanup
   - Depends on: #4
   - Complexity: Low
   - Files: `README.md` if behavior notes need clarification
   - Acceptance criteria: manual flow confirms the worktree disappears from the UI after delete, the directory is gone on disk, and associated Docker resources are gone; docs match implemented behavior if updated

## Implementation Details

### 1. Extend git worktree parsing

Files to modify:

- `tui/src/types/git.ts`
- `tui/src/utils/git-parser.ts`
- `tui/src/__tests__/utils/git-parser.test.ts`

Key functions and classes:

- `parseWorktreeList` in `tui/src/utils/git-parser.ts:24`
- `WorktreeInfo` in `tui/src/types/git.ts:8`

Guidance:

- Add explicit fields to `WorktreeInfo` for stale-entry metadata, likely `prunable: boolean` and optionally `prunableReason: string | null`
- Update `parseWorktreeList` to recognize extra porcelain keys instead of silently ignoring them; the parser already uses a block-based pattern that is easy to extend
- Follow the same test style used in `tui/src/__tests__/utils/git-parser.test.ts:4`

Code pattern to follow:

- The current parser accumulates one `current` block and pushes it on blank lines; extend that pattern rather than rewriting the parser architecture

Gotchas and edge cases:

- `git worktree list --porcelain` may emit stale metadata even when `branch` is still present; do not assume stale entries are branchless
- Preserve support for output without a trailing blank line

### 2. Harden worktree listing

Files to modify or create:

- `tui/src/services/WorktreeService.ts`
- `tui/src/types/worktree.ts` only if an additional internal flag is truly needed
- `tui/src/__tests__/services/WorktreeService.test.ts`

Key functions and classes:

- `WorktreeService.list` in `tui/src/services/WorktreeService.ts:85`
- `WorktreeService.detectOrphans` in `tui/src/services/WorktreeService.ts:193`

Guidance:

- Treat stale git entries differently from valid worktrees: if a git entry is marked prunable or its directory does not exist, it should not come back as a normal list item
- Decide whether to filter stale git entries out immediately or prune them before returning results; either way, the final visible behavior should be that deleted worktrees do not remain in the list
- Keep the existing orphan concept for state-only entries (`isOrphaned`) intact; that path is still used by prune workflows and should not be conflated with stale git admin entries

Code patterns to follow:

- The current `gitPaths` merge logic in `tui/src/services/WorktreeService.ts:95`
- The existing orphan display behavior in `tui/src/components/WorktreeList.tsx:24`

Gotchas and edge cases:

- Do not accidentally hide the main repo entry twice; `WorktreeService.list` already skips `gitWt.path === repo.path`
- Pattern B and Pattern C worktrees do not use the `__wt__` sibling naming convention, so list cleanup must rely on actual repo/worktree metadata, not name heuristics

### 3. Make delete cleanup authoritative

Files to modify or create:

- `tui/src/services/WorktreeService.ts`
- `tui/src/services/GitService.ts`
- `tui/src/commands/DeleteWorktreeCommand.ts`
- `tui/src/__tests__/commands/DeleteWorktreeCommand.test.ts`
- `tui/src/__tests__/services/WorktreeService.test.ts`

Key functions and classes:

- `DeleteWorktreeCommand.execute` in `tui/src/commands/DeleteWorktreeCommand.ts:27`
- `WorktreeService.remove` in `tui/src/services/WorktreeService.ts:142`
- `GitService.worktreeRemove`, `GitService.worktreeRemoveForce`, and `GitService.worktreePrune` in `tui/src/services/GitService.ts:45`

Guidance:

- After calling git remove, explicitly verify the outcome: re-check `git worktree list` and confirm the deleted path is gone before claiming success
- If git successfully unregisters the worktree but the directory still exists, remove that directory explicitly with a guarded filesystem delete; this should be implemented in `WorktreeService`, not in the UI layer
- Add a strong safety guard before filesystem deletion: only delete `wt.path`, never `repo.path`, and reject deletion if the paths are equal or if `wt.path` resolves outside the configured worktree patterns
- Keep state removal last so a failed cleanup does not make it impossible to retry from the UI

Code patterns to follow:

- The sequencing in `DeleteWorktreeCommand.execute` already matches the desired orchestration style
- `StartContainerCommand` in `tui/src/commands/StartContainerCommand.ts:21` is a good example of returning precise user-facing messages from service-layer outcomes

Gotchas and edge cases:

- Force mode currently continues after git removal failure in `tui/src/services/WorktreeService.ts:151`; decide explicitly whether that should still be allowed once directory deletion and verification are added
- If the directory was manually deleted before the command runs, the operation should still clean git admin/state and end successfully
- Never delete the main repo even if a bad state entry points to it

### 4. Harden container teardown

Files to modify:

- `tui/src/services/ContainerRuntimeService.ts`
- `tui/src/commands/DeleteWorktreeCommand.ts`
- `tui/src/__tests__/services/ContainerRuntimeService.test.ts`
- `tui/src/__tests__/commands/DeleteWorktreeCommand.test.ts`

Key functions and classes:

- `ContainerRuntimeService.removeEnvironment` in `tui/src/services/ContainerRuntimeService.ts:146`
- `ContainerRuntimeService.removeContainer` in `tui/src/services/ContainerRuntimeService.ts:280`

Guidance:

- Preserve the current idempotent behavior for missing Docker objects, but broaden tests so all expected "already removed" cases are covered consistently
- Keep Docker cleanup ahead of git/state cleanup so the command does not leave hidden container resources behind after the worktree disappears from the UI
- If Docker cleanup fails for a real reason, return a clear message from `DeleteWorktreeCommand` and avoid reporting the worktree as deleted

Code patterns to follow:

- `ContainerRuntimeService.stop` and `removeContainer` already normalize missing-object errors into safe outcomes; extend that style instead of adding UI-specific conditionals

Gotchas and edge cases:

- Docker error text varies slightly by command; tests should cover the exact messages the service currently handles (`No such container`, `No such network`, `No such volume`, `No such object`)
- A worktree may have persisted container metadata even if the container was never successfully started; teardown still needs to be safe

### 5. Validation and docs

Files to modify if needed:

- `README.md`

Guidance:

- Only update docs if implementation changes the stated behavior or error recovery guidance
- If docs are updated, clarify that delete removes the selected worktree directory and environment only, never the main repo

## Testing Strategy

Automated tests to add or update:

- `tui/src/__tests__/utils/git-parser.test.ts`: add cases for `prunable` worktree entries and mixed active/stale output
- `tui/src/__tests__/services/WorktreeService.test.ts`: cover list filtering, orphan handling, and guarded deletion behavior
- `tui/src/__tests__/commands/DeleteWorktreeCommand.test.ts`: cover success path, container-cleanup failure, already-missing directory, and main-repo safety guard
- `tui/src/__tests__/services/ContainerRuntimeService.test.ts`: verify missing Docker objects are tolerated during environment removal

Manual testing steps:

1. Create a repo and a disposable worktree in Swarm, then delete it with `d`; confirm it disappears from the worktree list immediately after refresh.
2. Check the filesystem and confirm the worktree path is gone while the main repo path still exists.
3. Run `git -C <repo-path> worktree list --porcelain` and confirm the deleted path is absent.
4. Repeat the flow with an attached container; confirm `docker ps -a`, `docker network ls`, and `docker volume ls` no longer show the worktree resources.
5. Simulate a stale admin entry by manually removing a worktree directory, then refresh Swarm; confirm the stale entry is not shown as an active worktree and can be cleaned correctly.

Project commands:

- Install deps: `cd tui && bun install`
- Run tests: `cd tui && bun test`
- Lint: `cd tui && bun run lint`
- Type check: `cd tui && bun run typecheck`

Project type note:

- This project is TypeScript/Bun, so `/rspec-test-agent` is not applicable here.

End-to-end verification:

- Launch the app with `cd tui && bun run start`
- Delete a worktree with and without container metadata
- Verify the status message reflects the real cleanup result and the deleted item does not reappear on the next refresh or app restart

## Definition of Done

- [ ] All subtasks completed
- [ ] Tests passing (`cd tui && bun test`)
- [ ] Code follows project conventions
- [ ] No linter or type offenses (`cd tui && bun run lint` and `cd tui && bun run typecheck`)
