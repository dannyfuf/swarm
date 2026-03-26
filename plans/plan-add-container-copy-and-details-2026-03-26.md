# Implementation Plan: Container Config Copy + Detail Panel Improvements
Generated: 2026-03-26

## Summary

Add a small TUI usability improvement so users can quickly copy the repo's container config path and see container-config context directly in the worktree detail panel. This builds on the existing container workflow rather than changing runtime behavior: `g` already creates a scaffold, `DetailView` already shows runtime metadata, and the new work should make config discovery and inspection easier.

### Context & Scope

Affected files, modules, and directories:

- `tui/src/App.tsx`
- `tui/src/components/DetailView.tsx`
- `tui/src/components/HelpDialog.tsx`
- `tui/src/components/StatusBar.tsx`
- `tui/src/hooks/useKeyboardShortcuts.ts`
- `tui/src/services/ContainerConfigService.ts`
- `tui/src/commands/CopyToClipboardCommand.ts`
- `tui/src/__tests__/components/Dialog.test.tsx`
- `tui/src/__tests__/services/ContainerConfigService.test.ts`
- `README.md`

In scope:

- Add a dedicated TUI action to copy the expected container config path to the clipboard
- Surface container-config information in the worktree detail panel
- Show whether the config exists, and if possible surface parsed config metadata such as preset
- Update keyboard help, status-bar hints, and docs to advertise the new action
- Add automated coverage for the new summary/copy UX

Out of scope:

- Copying full YAML file contents to the clipboard
- Opening the config in an editor from the TUI
- Changing Docker build/start/stop/delete behavior
- Redesigning the full detail panel layout beyond the container section
- Adding new non-TUI container CLI commands

## Prerequisites

### Environment setup

- Project type: TypeScript + Bun + OpenTUI React
- Install dependencies with `cd tui && bun install`
- Use Bun >= 1.0 so `bun test`, `bun run lint`, and `bun run typecheck` work as documented in `tui/package.json:5`
- Clipboard verification is easiest on macOS (`pbcopy`) or Linux with `xclip`/`xsel`; clipboard behavior is implemented in `tui/src/services/ClipboardService.ts:15`

### Relevant project structure knowledge

- TUI action orchestration lives in `tui/src/App.tsx:267` and `tui/src/App.tsx:431`
- Global key handling lives in `tui/src/hooks/useKeyboardShortcuts.ts:33`
- Shortcut documentation lives in `tui/src/components/HelpDialog.tsx:15`
- Bottom-bar key hints live in `tui/src/components/StatusBar.tsx:74`
- Worktree detail rendering lives in `tui/src/components/DetailView.tsx:22`
- Repo container config path resolution already exists in `tui/src/services/ContainerConfigService.ts:45`
- Container scaffold creation already exists in `tui/src/services/ContainerConfigService.ts:50` and `tui/src/commands/EnsureContainerConfigCommand.ts:15`

### Conventions to follow

- Keep filesystem and config lookup logic in services, not in React components; follow `tui/src/services/ContainerConfigService.ts:35`
- Reuse the existing command pattern for clipboard actions instead of adding direct service calls in components; follow `tui/src/commands/CopyToClipboardCommand.ts:10`
- Keep `App.tsx` responsible for wiring handlers and passing already-derived data into presentation components; follow `tui/src/App.tsx:527`
- Keep tests aligned with current Bun/OpenTUI test style in `tui/src/__tests__/components/Dialog.test.tsx:58`

### Background reading

- `README.md:149` for current container workflow and config-file location
- `tui/src/services/ContainerConfigService.ts:261` for the scaffold template and expected YAML shape
- `tui/src/components/DetailView.tsx:73` for existing container runtime fields already shown to the user

## Task Breakdown

1. Add a container-config summary API for the TUI
   - Depends on: none
   - Complexity: Medium
   - Acceptance criteria: the app can derive the expected config path for the selected repo and determine whether the file exists; if the file is valid, the summary can expose parsed metadata such as `preset`; invalid config does not crash the UI

2. Add a dedicated copy-container-config-path action in the TUI
   - Depends on: #1
   - Complexity: Low
   - Acceptance criteria: a user with a selected repo/worktree can trigger one shortcut and get the config path in their system clipboard; the status message clearly says what was copied

3. Extend the detail panel with container-config context
   - Depends on: #1
   - Complexity: Medium
   - Acceptance criteria: the detail panel shows the config path plus a friendly state such as present, missing, or invalid; existing runtime/container metadata continues to render correctly

4. Update discoverability text across the TUI and docs
   - Depends on: #2 and #3
   - Complexity: Low
   - Acceptance criteria: help dialog, status bar, and README shortcut list mention the new copy action and clarify the difference between scaffold creation and config-path copying

5. Add automated coverage and run validation commands
   - Depends on: #1, #2, #3, and #4
   - Complexity: Medium
   - Acceptance criteria: tests cover config-summary behavior and updated help/detail rendering; `bun test`, `bun run lint`, `bun run typecheck`, and `bun run build` pass

## Implementation Details

### 1. Add a container-config summary API for the TUI

Files to modify or create:

- `tui/src/services/ContainerConfigService.ts`
- `tui/src/types/container.ts`
- `tui/src/App.tsx`

Key functions/classes to work with:

- `ContainerConfigService.getExpectedConfigPath()` in `tui/src/services/ContainerConfigService.ts:45`
- `ContainerConfigService.loadForRepo()` in `tui/src/services/ContainerConfigService.ts:73`
- `App` selection/render flow in `tui/src/App.tsx:547`

Recommended approach:

- Add a small service-level summary return type, for example `ContainerConfigSummary`, with fields such as `path`, `exists`, `isValid`, `preset`, and `error`
- Prefer a single service method like `getSummaryForRepo(repoPath: string)` so the UI does not need to perform filesystem I/O or parse YAML itself
- Use the existing expected-path logic as the source of truth for the displayed path, even when the file is missing
- Only parse YAML when the file exists; if parsing/validation fails, return a summary object with the error string instead of throwing into the render path

Code patterns to follow:

- Existing path resolution in `tui/src/services/ContainerConfigService.ts:45`
- Existing validation flow in `tui/src/services/ContainerConfigService.ts:94`
- Existing derived-selection memo pattern in `tui/src/App.tsx:547`

Potential gotchas and edge cases:

- Container config is repo-scoped, not worktree-scoped; do not recompute different paths per worktree
- Avoid auto-creating the scaffold during passive detail rendering; the panel should report state, not mutate it
- A malformed YAML file should show as invalid in the UI instead of falling back to “missing”

### 2. Add a dedicated copy-container-config-path action in the TUI

Files to modify:

- `tui/src/App.tsx`
- `tui/src/hooks/useKeyboardShortcuts.ts`
- `tui/src/components/StatusBar.tsx`
- `tui/src/components/HelpDialog.tsx`

Key functions/classes to work with:

- `CopyToClipboardCommand` in `tui/src/commands/CopyToClipboardCommand.ts:10`
- Existing generic copy handler in `tui/src/App.tsx:431`
- Keyboard switch in `tui/src/hooks/useKeyboardShortcuts.ts:49`

Recommended approach:

- Add a separate handler in `App.tsx` that copies the selected repo's container config path using the new summary/path helper
- Recommended shortcut: `y` for “yank config path”; this avoids overloading `g`, which already means “create config scaffold” in `tui/src/hooks/useKeyboardShortcuts.ts:84`
- Make the action available anywhere a repo is selected; that includes worktree/detail focus because the selected worktree still belongs to the selected repo
- Use the existing clipboard command so success/error handling stays consistent with path and branch copying

Code patterns to follow:

- `handleCopy()` in `tui/src/App.tsx:431`
- `handleCopyBranch()` in `tui/src/App.tsx:445`
- Existing key-hint plumbing in `tui/src/App.tsx:527`

Potential gotchas and edge cases:

- If the config file does not exist yet, still copy the expected path; pair the success status with guidance like “file not created yet” if helpful
- Do not require a selected worktree when a selected repo is sufficient
- Keep the copy action read-only; scaffold creation remains the only write path

### 3. Extend the detail panel with container-config context

Files to modify:

- `tui/src/components/DetailView.tsx`
- `tui/src/App.tsx`
- `tui/src/types/container.ts`

Key functions/classes to work with:

- `DetailView` in `tui/src/components/DetailView.tsx:22`
- Existing selected container status memo in `tui/src/App.tsx:552`

Recommended approach:

- Pass a `containerConfigSummary` prop into `DetailView` rather than letting the component fetch its own data
- Keep the existing runtime section, but add a distinct config subsection above or beside it so users can distinguish config state from live container state
- Show at least:
  - config path
  - config state (`present`, `missing`, or `invalid`)
  - preset when available
  - validation error when invalid
- If you want a lightweight affordance in the panel, add a short hint like `Press y to copy config path`, but keep it secondary to the actual data

Code patterns to follow:

- Current text-row rendering style in `tui/src/components/DetailView.tsx:35`
- Existing warning rendering in `tui/src/components/DetailView.tsx:118`

Potential gotchas and edge cases:

- The panel already shows runtime metadata like URL, health, container name, and images; extend that section rather than replacing it
- Handle worktrees with no stored `container` metadata but a valid repo config; config presence and runtime existence are separate states
- Keep line lengths and wording readable in narrow terminals

### 4. Update discoverability text across the TUI and docs

Files to modify:

- `tui/src/components/HelpDialog.tsx`
- `tui/src/components/StatusBar.tsx`
- `README.md`

Key functions/classes to work with:

- `SHORTCUTS` in `tui/src/components/HelpDialog.tsx:15`
- `getKeyHints()` in `tui/src/components/StatusBar.tsx:74`
- Keyboard shortcut table in `README.md:58`

Recommended approach:

- Make the wording explicit:
  - `g`: create config scaffold
  - `y`: copy container config path
- Update worktree/detail hints so the shortcut is discoverable without opening help
- Update README shortcut docs and, if useful, add one sentence near `README.md:159` explaining that the TUI can copy the expected config location even before the file exists

Potential gotchas and edge cases:

- Keep terminology consistent between help text, status text, and docs; use either “container config path” or “container config file path” everywhere
- Do not imply that `y` copies file contents unless that is intentionally implemented

### 5. Add automated coverage and run validation commands

Files to modify:

- `tui/src/__tests__/services/ContainerConfigService.test.ts`
- `tui/src/__tests__/components/Dialog.test.tsx`
- Optionally add a focused app/handler test if there is already a pattern elsewhere in the test suite

Key functions/classes to work with:

- Existing config-service tests in `tui/src/__tests__/services/ContainerConfigService.test.ts:13`
- Existing help/detail component tests in `tui/src/__tests__/components/Dialog.test.tsx:58`

Tests to add or update:

- Service test: summary returns `exists=false` and expected path when config is missing
- Service test: summary returns `exists=true`, `isValid=true`, and `preset` when config is valid
- Service test: summary returns `isValid=false` plus error when YAML exists but fails validation
- Component test: help dialog includes the new copy-config shortcut text
- Component test: detail view renders config path/state/preset for a selected worktree
- Component test: detail view renders an invalid-config error state without crashing

Manual testing steps:

1. Run `cd tui && bun run start`
2. Select a repo with no container config; confirm the detail panel shows the expected path and a missing state
3. Trigger the new copy shortcut; confirm the clipboard contains the expected config path
4. Press `g` to create the scaffold; confirm the status/help dialog still shows the created path
5. Return to the same repo/worktree; confirm the detail panel now shows the config as present
6. Edit the YAML to use a known preset; confirm the detail panel surfaces that preset
7. Break the YAML intentionally; confirm the detail panel shows an invalid state instead of crashing the app

End-to-end verification:

- Verify the copy action works from both the worktree panel and the detail panel when a repo is selected
- Verify the displayed config path matches the path printed by the existing scaffold flow
- Verify runtime container details still render for started worktrees after the detail panel changes

Project commands:

- Install deps: `cd tui && bun install`
- Run tests: `cd tui && bun test`
- Lint: `cd tui && bun run lint`
- Type check: `cd tui && bun run typecheck`
- Build: `cd tui && bun run build`

`/rspec-test-agent` is not applicable here because this repository is TypeScript/Bun, not Ruby/Rails.

## Testing Strategy

- Unit tests: cover the new container-config summary API in `ContainerConfigService`
- Component tests: cover updated shortcut help text and detail-panel config rendering
- Manual tests: verify missing, present, and invalid config states plus clipboard behavior
- Validation commands:
  - `cd tui && bun test`
  - `cd tui && bun run lint`
  - `cd tui && bun run typecheck`
  - `cd tui && bun run build`

## Definition of Done

- [ ] All subtasks completed
- [ ] Tests passing
- [ ] Code follows project conventions
- [ ] No linter or type offenses
- [ ] `cd tui && bun test` passes
- [ ] `cd tui && bun run lint` passes
- [ ] `cd tui && bun run typecheck` passes
- [ ] `cd tui && bun run build` passes
- [ ] The TUI can copy the expected container config path from a selected repo/worktree
- [ ] The detail panel shows container-config context without regressing existing runtime container information
