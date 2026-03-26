# Implementation Plan: Remote Repository Download

Generated: 2026-03-26

## Summary

Add a full-screen overlay to the Swarm TUI that lets users browse their accessible GitHub repositories, see which ones are already cloned locally, and clone new repos into the configured `aiWorkingDir`. The overlay is triggered by a keyboard shortcut (`f` for "fetch repo"), uses the GitHub REST API via `git` CLI for auth and cloning, does not block the UI during clone operations (leveraging the existing `ActivityOverlay` spinner system), and auto-refreshes the local repo list on completion.

This feature fills a critical gap: currently, users must manually clone repos outside the TUI, then restart to see them. With this change, the entire repo lifecycle -- from discovery through worktree management -- lives inside the TUI.

**Project type:** Bun + TypeScript + React (via `@opentui/react`) terminal UI.

## Prerequisites

### Environment

- **Bun >= 1.0** (runtime)
- **Git CLI** with authenticated remote access (SSH keys or credential helper configured for GitHub)
- Terminal with at least 80x24 for comfortable overlay rendering
- Docker, tmux for full manual testing (not strictly needed for this feature)

### Install & Run

```bash
cd tui
bun install
bun run start        # Launch the TUI
bun test             # Run all tests
bun run typecheck    # TypeScript type check
bun run lint         # Biome linter
```

### Required Background Reading

Before coding, read these files:

| File | Why |
|------|-----|
| `tui/src/App.tsx` | Master orchestrator -- all command callbacks, panel layout, overlay rendering |
| `tui/src/state/actions.ts` | All action types (pattern for adding new ones) |
| `tui/src/state/appReducer.ts` | Reducer patterns, `AppState` shape |
| `tui/src/components/Dialog.tsx` | Overlay modal pattern (keyboard handling, absolute positioning, styling) |
| `tui/src/components/InputDialog.tsx` | Overlay with `<input>` -- pattern for search/filter input |
| `tui/src/components/ActivityOverlay.tsx` | Non-blocking background activity spinner pattern |
| `tui/src/utils/activity.ts` | `createActivityTracker` / `trackActivity` pattern |
| `tui/src/services/RepoService.ts` | How repos are discovered from `config.aiWorkingDir` |
| `tui/src/services/GitService.ts` | Git CLI wrapper patterns (sync + async) |
| `tui/src/utils/shell.ts` | `exec()` / `execSync()` wrappers around `Bun.spawn` |
| `tui/src/commands/Command.ts` | Command interface: `execute(): Promise<CommandResult>` |
| `tui/src/hooks/useKeyboardShortcuts.ts` | How shortcuts are wired and the priority system |

### Coding Conventions

- **Named exports only** -- `biome.json` has `"noDefaultExport": "error"`
- **No unused imports/vars** -- Biome warns on them
- **`useImportType`** -- Import types with `import type { X }` 
- **2-space indent, double quotes, no semicolons** (Biome formatter config)
- **100-char line width**
- **Services injected via constructor** -- never singletons
- **Commands return `CommandResult`** -- never throw to the UI layer
- **JSDoc comments** on every exported function/class/interface, matching existing style

## Scope

### In Scope

- New `GitHubService` that discovers remote repos the user has access to via `git ls-remote` / GitHub API
- New `CloneRepoCommand` implementing the `Command` pattern
- New `RepoBrowser` full-screen overlay component with:
  - Text filter/search input at the top
  - Scrollable `<select>` list of repos
  - Visual distinction between "installed" (already cloned) and "available" repos
  - Clone action on Enter for available repos
  - Non-blocking clone with `ActivityOverlay` spinner
  - Auto-refresh repo list after successful clone
- State additions: `showRepoBrowser` flag, `remoteRepos` array, `remoteReposLoading` flag
- New keyboard shortcut `f` to toggle the overlay
- Updates to `HelpDialog` shortcuts list
- Updates to `StatusBar` key hints
- Unit tests for the new service, command, and reducer actions

### Out of Scope

- GitHub Enterprise / GitLab / Bitbucket support (only GitHub public + private repos via authenticated git)
- SSH key management or credential setup
- Repository deletion from remote
- Pagination for users with 1000+ repos (initial implementation loads all; can paginate later)
- Forking repos
- Configuring which GitHub orgs to scan

## Task Breakdown

### Task 1: Create `GitHubService` for remote repo discovery

- **Requires:** none
- **Complexity:** Medium
- **Files:**
  - NEW: `tui/src/services/GitHubService.ts`
  - NEW: `tui/src/types/github.ts`
  - NEW: `tui/src/__tests__/services/GitHubService.test.ts`

**Acceptance criteria:**
- `GitHubService.listAccessibleRepos()` returns an array of `RemoteRepo` objects
- Each `RemoteRepo` has: `fullName` (owner/repo), `name`, `cloneUrl`, `description`, `isPrivate`, `defaultBranch`, `updatedAt`
- Uses `gh api` CLI if available, falls back to `git ls-remote --heads` against known orgs
- Handles errors gracefully (returns `CommandResult`-style errors, never throws)
- Unit tests verify parsing and error handling with mock shell output

### Task 2: Create `RemoteRepo` types

- **Requires:** none (can be done in parallel with Task 1)
- **Complexity:** Low
- **Files:**
  - NEW: `tui/src/types/github.ts`

**Acceptance criteria:**
- `RemoteRepo` interface defined with all needed fields
- `RepoAvailability` type: `"installed" | "available" | "cloning"`
- `BrowsableRepo` type combining `RemoteRepo` + `RepoAvailability` for the UI

### Task 3: Create `CloneRepoCommand`

- **Requires:** Task 1, Task 2
- **Complexity:** Medium
- **Files:**
  - NEW: `tui/src/commands/CloneRepoCommand.ts`
  - NEW: `tui/src/__tests__/commands/CloneRepoCommand.test.ts`

**Acceptance criteria:**
- Implements `Command` interface
- Takes `GitService` (or `GitHubService`), config `aiWorkingDir`, and `RemoteRepo` as constructor args
- Clones into `config.aiWorkingDir/<repo-name>` using `git clone` via async `exec()`
- Returns success with the cloned path, or failure with a meaningful error message
- Does NOT block the event loop (uses `Bun.spawn` async path)
- Test covers success, failure (clone error), and already-exists scenarios

### Task 4: Add state management for the repo browser overlay

- **Requires:** Task 2
- **Complexity:** Medium
- **Files:**
  - MODIFY: `tui/src/state/actions.ts`
  - MODIFY: `tui/src/state/appReducer.ts`
  - MODIFY: `tui/src/__tests__/state/appReducer.test.ts`

**Acceptance criteria:**
- New actions:
  - `SHOW_REPO_BROWSER` -- sets `showRepoBrowser: true`
  - `HIDE_REPO_BROWSER` -- sets `showRepoBrowser: false`, clears `remoteRepos`
  - `SET_REMOTE_REPOS` -- sets `remoteRepos: BrowsableRepo[]`, clears `remoteReposLoading`
  - `SET_REMOTE_REPOS_LOADING` -- sets `remoteReposLoading: true`
  - `SET_REMOTE_REPO_STATUS` -- updates a single repo's `availability` field (for marking "cloning" -> "installed")
- New state fields in `AppState`:
  - `showRepoBrowser: boolean` (default: `false`)
  - `remoteRepos: BrowsableRepo[]` (default: `[]`)
  - `remoteReposLoading: boolean` (default: `false`)
- Reducer tests for all new actions
- `SHOW_REPO_BROWSER` should be blocked when `inputMode !== "none"` or `showDialog` is true (guard in the shortcut handler, not the reducer)

### Task 5: Build the `RepoBrowser` overlay component

- **Requires:** Task 2, Task 4
- **Complexity:** High
- **Files:**
  - NEW: `tui/src/components/RepoBrowser.tsx`

**Acceptance criteria:**
- Full-screen overlay (same pattern as `Dialog.tsx`: `position="absolute"`, `width="100%"`, `height="100%"`, black background)
- Layout:
  ```
  ┌─────────────── Download Repository ───────────────┐
  │ Search: [________________________]                 │
  │                                                    │
  │  owner/repo-name         [INSTALLED]               │
  │  owner/another-repo      [AVAILABLE]               │
  │  owner/third-repo        [CLONING...]              │
  │  ...                                               │
  │                                                    │
  │ [Esc] Close   [Enter] Clone   [/] Search           │
  └────────────────────────────────────────────────────┘
  ```
- Contains a text `<input>` for filtering (focused by default)
- Contains a `<select>` list showing repos with status badges
- `Tab` switches focus between search input and select list
- `Enter` on an "available" repo triggers clone
- `Enter` on an "installed" repo is a no-op (or shows a status message)
- `Esc` closes the overlay
- Handles its own keyboard via `useKeyboard` (same pattern as `Dialog.tsx`)
- Shows `<Spinner>` + "Loading repositories..." when `remoteReposLoading` is true
- Client-side filtering: filter `remoteRepos` by `fullName` matching the search input
- Repos sorted: "available" first, then "installed", alphabetically within each group

### Task 6: Wire `GitHubService` into the service graph

- **Requires:** Task 1
- **Complexity:** Low
- **Files:**
  - MODIFY: `tui/src/state/AppContext.tsx` (add `github: GitHubService` to `Services`)
  - MODIFY: `tui/src/index.tsx` (instantiate `GitHubService`, add to services object)

**Acceptance criteria:**
- `GitHubService` instantiated in `index.tsx` with `GitService` dependency
- Added to the `Services` interface and the `services` object
- Available throughout the component tree via `useServices()`

### Task 7: Wire the overlay into `App.tsx`

- **Requires:** Task 3, Task 4, Task 5, Task 6
- **Complexity:** High
- **Files:**
  - MODIFY: `tui/src/App.tsx`
  - MODIFY: `tui/src/hooks/useKeyboardShortcuts.ts`
  - MODIFY: `tui/src/components/HelpDialog.tsx`
  - MODIFY: `tui/src/components/StatusBar.tsx`

**Acceptance criteria:**
- `f` key opens the RepoBrowser overlay (dispatches `SET_REMOTE_REPOS_LOADING` then `SHOW_REPO_BROWSER`, fetches remote repos, dispatches `SET_REMOTE_REPOS`)
- `Esc` from RepoBrowser dispatches `HIDE_REPO_BROWSER`
- When `showRepoBrowser` is true, global shortcuts are suppressed (same pattern as `showDialog`/`inputMode`)
- Clone action: creates a `CloneRepoCommand`, wraps in `trackActivity()`, dispatches `SET_REMOTE_REPO_STATUS` to mark "cloning", on success calls `loadRepos()` and dispatches `SET_REMOTE_REPO_STATUS` to mark "installed"
- After successful clone, a `SET_STATUS` message confirms ("Cloned owner/repo-name")
- HelpDialog updated with `f` shortcut entry
- StatusBar updated with `f: fetch repo` in key hints
- RepoBrowser rendered as a conditional overlay in the JSX tree (same pattern as InputDialog/Dialog)

### Task 8: Add `ActivityKind` for clone operations

- **Requires:** Task 4
- **Complexity:** Low
- **Files:**
  - MODIFY: `tui/src/types/activity.ts`

**Acceptance criteria:**
- New `ActivityKind`: `"clone-repo"`
- Activity label format: `"Cloning owner/repo-name..."`
- Clone shows in `ActivityOverlay` while in progress

## Implementation Details

### Task 1: `GitHubService`

The service should try two approaches in order:

1. **`gh` CLI** (preferred): `gh repo list --json name,nameWithOwner,url,description,isPrivate,defaultBranchRef,updatedAt --limit 200`
   - Parse JSON output directly
   - Also fetch org repos: `gh repo list <org> --json ...` for each configured org

2. **Fallback -- GitHub REST API via git credential**: Use `git credential fill` to get a token, then call `https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member` using `fetch()`.

For the initial implementation, use approach 2 (GitHub REST API via `fetch()`) since `gh` is not guaranteed to be installed. The service should:

```typescript
// tui/src/services/GitHubService.ts
export class GitHubService {
  constructor(private readonly git: GitService) {}

  async listAccessibleRepos(): Promise<RemoteRepo[]> {
    // 1. Get GitHub token from git credential helper
    const token = await this.getGitHubToken()
    if (!token) {
      throw new Error("No GitHub credentials found. Run 'gh auth login' or configure git credentials.")
    }

    // 2. Fetch repos from GitHub API
    const repos = await this.fetchRepos(token)
    return repos
  }

  private async getGitHubToken(): Promise<string | null> {
    // Use git credential fill to get token
    // echo "protocol=https\nhost=github.com\n" | git credential fill
    // Parse the password= line
  }

  private async fetchRepos(token: string): Promise<RemoteRepo[]> {
    // Paginate through /user/repos
    // Return parsed RemoteRepo[]
  }

  async cloneRepo(cloneUrl: string, targetDir: string): Promise<void> {
    // git clone <url> <targetDir>
    const result = await exec("git", ["clone", cloneUrl, targetDir])
    if (!result.success) {
      throw new Error(`git clone failed: ${result.stderr}`)
    }
  }
}
```

**Key pattern to follow:** Look at how `GitService` wraps CLI calls in `tui/src/services/GitService.ts:231-237` (async methods using `exec()`).

### Task 2: Types

```typescript
// tui/src/types/github.ts
export interface RemoteRepo {
  fullName: string        // "owner/repo-name"
  name: string            // "repo-name"
  cloneUrl: string        // "https://github.com/owner/repo-name.git"
  description: string     // repo description or ""
  isPrivate: boolean
  defaultBranch: string   // "main"
  updatedAt: string       // ISO date string
}

export type RepoAvailability = "installed" | "available" | "cloning"

export interface BrowsableRepo {
  remote: RemoteRepo
  availability: RepoAvailability
}
```

### Task 3: `CloneRepoCommand`

Follow the exact same pattern as `CreateWorktreeCommand` (`tui/src/commands/CreateWorktreeCommand.ts`):

```typescript
// tui/src/commands/CloneRepoCommand.ts
export class CloneRepoCommand implements Command {
  constructor(
    private readonly github: GitHubService,
    private readonly aiWorkingDir: string,
    private readonly repo: RemoteRepo,
  ) {}

  async execute(): Promise<CommandResult> {
    try {
      const targetDir = join(this.aiWorkingDir, this.repo.name)
      if (existsSync(targetDir)) {
        return {
          success: false,
          message: `Repository "${this.repo.name}" already exists at ${targetDir}`,
        }
      }
      await this.github.cloneRepo(this.repo.cloneUrl, targetDir)
      return {
        success: true,
        message: `Cloned ${this.repo.fullName}`,
        data: { path: targetDir },
      }
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : "Unknown error cloning repository",
      }
    }
  }
}
```

### Task 4: State changes

**actions.ts** -- add to the `AppAction` union:

```typescript
| { type: "SHOW_REPO_BROWSER" }
| { type: "HIDE_REPO_BROWSER" }
| { type: "SET_REMOTE_REPOS"; repos: BrowsableRepo[] }
| { type: "SET_REMOTE_REPOS_LOADING" }
| { type: "SET_REMOTE_REPO_STATUS"; fullName: string; availability: RepoAvailability }
```

**appReducer.ts** -- add to `AppState`:

```typescript
showRepoBrowser: boolean       // false
remoteRepos: BrowsableRepo[]   // []
remoteReposLoading: boolean    // false
```

Reducer cases:

```typescript
case "SHOW_REPO_BROWSER":
  return { ...state, showRepoBrowser: true }

case "HIDE_REPO_BROWSER":
  return { ...state, showRepoBrowser: false, remoteRepos: [], remoteReposLoading: false }

case "SET_REMOTE_REPOS":
  return { ...state, remoteRepos: action.repos, remoteReposLoading: false }

case "SET_REMOTE_REPOS_LOADING":
  return { ...state, remoteReposLoading: true }

case "SET_REMOTE_REPO_STATUS":
  return {
    ...state,
    remoteRepos: state.remoteRepos.map((r) =>
      r.remote.fullName === action.fullName
        ? { ...r, availability: action.availability }
        : r,
    ),
  }
```

### Task 5: `RepoBrowser` component

Follow `Dialog.tsx` pattern for the overlay shell and `InputDialog.tsx` pattern for the input:

```tsx
// tui/src/components/RepoBrowser.tsx

// Key UX decisions:
// 1. Two-zone focus: input (filter) and select (repo list), toggled with Tab
// 2. Installed repos shown with green [INSTALLED] badge, available with yellow [CLONE]
// 3. Cloning repos shown with spinner frame [CLONING...]
// 4. Empty state when no matches
// 5. Filter is case-insensitive substring match on fullName and description
```

**Component structure:**

```
<box position="absolute" full-screen backgroundColor="#000000">
  <box centered, bordered, width={70}, maxHeight="80%">
    <text title="Download Repository" />
    <box marginTop={1}>
      <input filter focused={inputFocused} />
    </box>
    <box marginTop={1} flexGrow={1}>
      {loading ? <Spinner /> + "Loading..." : <select options={filteredRepos} focused={!inputFocused} />}
    </box>
    <box footer hints>
      [Esc] Close  [Enter] Clone  [Tab] Switch focus
    </box>
  </box>
</box>
```

**Focus management pattern** (from OpenTUI `inputs.md` focus example):

```tsx
const [inputFocused, setInputFocused] = useState(true)

useKeyboard((key) => {
  if (key.name === "escape") { onClose(); return }
  if (key.name === "tab") { setInputFocused((v) => !v); return }
  // When select is focused and Enter is pressed on an "available" repo:
  if (!inputFocused && (key.name === "enter" || key.name === "return")) {
    const selected = filteredRepos[selectedIndex]
    if (selected?.availability === "available") {
      onClone(selected.remote)
    }
  }
})
```

**Select options formatting:**

```typescript
const options = filteredRepos.map((r) => ({
  name: formatRepoEntry(r),
  description: r.remote.description || r.remote.fullName,
  value: r,
}))

function formatRepoEntry(r: BrowsableRepo): string {
  const badge =
    r.availability === "installed" ? " [INSTALLED]" :
    r.availability === "cloning" ? " [CLONING...]" :
    ""
  return `${r.remote.fullName}${badge}`
}
```

### Task 7: `App.tsx` wiring

**Key callbacks to add:**

```typescript
const handleOpenRepoBrowser = useCallback(async () => {
  dispatch({ type: "SET_REMOTE_REPOS_LOADING" })
  dispatch({ type: "SHOW_REPO_BROWSER" })

  try {
    const remoteRepos = await services.github.listAccessibleRepos()
    const localRepoNames = new Set(state.repos.map((r) => r.name))

    const browsable: BrowsableRepo[] = remoteRepos.map((remote) => ({
      remote,
      availability: localRepoNames.has(remote.name) ? "installed" : "available",
    }))

    dispatch({ type: "SET_REMOTE_REPOS", repos: browsable })
  } catch (error) {
    dispatch({
      type: "SET_ERROR",
      message: error instanceof Error ? error.message : "Failed to fetch remote repos",
    })
    dispatch({ type: "HIDE_REPO_BROWSER" })
  }
}, [services.github, state.repos, dispatch])

const handleCloneRepo = useCallback(async (remote: RemoteRepo) => {
  dispatch({
    type: "SET_REMOTE_REPO_STATUS",
    fullName: remote.fullName,
    availability: "cloning",
  })

  await trackActivity(
    {
      kind: "clone-repo",
      label: `Cloning ${remote.fullName}...`,
      priority: "foreground",
      scope: { repoPath: join(services.config.get().aiWorkingDir, remote.name) },
    },
    async () => {
      const cmd = new CloneRepoCommand(
        services.github,
        services.config.get().aiWorkingDir,
        remote,
      )
      const result = await cmd.execute()
      if (result.success) {
        dispatch({
          type: "SET_REMOTE_REPO_STATUS",
          fullName: remote.fullName,
          availability: "installed",
        })
        dispatch({ type: "SET_STATUS", message: result.message })
        loadRepos() // Refresh local repo list
      } else {
        dispatch({
          type: "SET_REMOTE_REPO_STATUS",
          fullName: remote.fullName,
          availability: "available",
        })
        dispatch({ type: "SET_ERROR", message: result.message })
      }
    },
  )
}, [services.github, services.config, dispatch, trackActivity, loadRepos])
```

**Keyboard shortcut addition in `useKeyboardShortcuts.ts`:**

Add to the `KeyboardOptions` interface: `onOpenRepoBrowser: () => void`

Add to the switch statement:
```typescript
case "f":
  opts.onOpenRepoBrowser()
  break
```

**Guard in the early return:** Add `opts.state.showRepoBrowser` to the condition:
```typescript
if (opts.state.showDialog || opts.state.inputMode !== "none" || opts.state.showRepoBrowser) {
  return
}
```

**JSX overlay in `App.tsx` render:**
```tsx
{state.showRepoBrowser && (
  <box position="absolute" top={0} left={0} width="100%" height="100%">
    <RepoBrowser
      repos={state.remoteRepos}
      loading={state.remoteReposLoading}
      onClone={handleCloneRepo}
      onClose={() => dispatch({ type: "HIDE_REPO_BROWSER" })}
    />
  </box>
)}
```

## Testing Strategy

### Unit Tests

| Test File | What to Test |
|-----------|-------------|
| `tui/src/__tests__/services/GitHubService.test.ts` | Token extraction parsing, API response parsing, error handling |
| `tui/src/__tests__/commands/CloneRepoCommand.test.ts` | Success path, already-exists guard, clone failure |
| `tui/src/__tests__/state/appReducer.test.ts` (extend) | All 5 new actions, initial state defaults |

**Testing pattern** -- Follow the existing mock-injection pattern (see `tui/src/__tests__/commands/StartContainerCommand.test.ts`):

```typescript
// Example test for CloneRepoCommand
describe("CloneRepoCommand", () => {
  test("clones repo successfully", async () => {
    const command = new CloneRepoCommand(
      { cloneRepo: async () => undefined } as never,
      "/tmp/ai_working",
      { fullName: "owner/repo", name: "repo", cloneUrl: "https://..." } as never,
    )
    // Mock existsSync to return false
    const result = await command.execute()
    expect(result.success).toBe(true)
    expect(result.message).toContain("Cloned owner/repo")
  })
})
```

**Reducer test additions:**

```typescript
test("SHOW_REPO_BROWSER sets showRepoBrowser to true", () => {
  const state = appReducer(initialState, { type: "SHOW_REPO_BROWSER" })
  expect(state.showRepoBrowser).toBe(true)
})

test("HIDE_REPO_BROWSER resets all repo browser state", () => {
  const stateWithBrowser: AppState = {
    ...initialState,
    showRepoBrowser: true,
    remoteRepos: [{ remote: mockRemoteRepo, availability: "available" }],
    remoteReposLoading: false,
  }
  const state = appReducer(stateWithBrowser, { type: "HIDE_REPO_BROWSER" })
  expect(state.showRepoBrowser).toBe(false)
  expect(state.remoteRepos).toEqual([])
  expect(state.remoteReposLoading).toBe(false)
})

test("SET_REMOTE_REPO_STATUS updates a single repo's availability", () => {
  // ...
})
```

### Manual Testing Steps

1. **Prerequisites:** Ensure `git credential fill` works for github.com (run `echo "protocol=https\nhost=github.com" | git credential fill` to verify)
2. **Open the TUI:** `cd tui && bun run start`
3. **Press `f`** -- should show "Loading repositories..." with spinner
4. **Repos load** -- should show a list with [INSTALLED] / [CLONE] badges
5. **Type in filter** -- list should narrow in real-time
6. **Tab** -- focus should toggle between search input and repo list
7. **Navigate to an available repo, press Enter** -- should show "Cloning..." spinner in `ActivityOverlay`, repo badge should change to [CLONING...]
8. **Clone completes** -- badge changes to [INSTALLED], local repo list in left panel updates
9. **Press Esc** -- overlay closes, newly cloned repo visible in the Repositories panel
10. **Press `f` again** -- the just-cloned repo should now show as [INSTALLED]
11. **Error case:** Disconnect network, press `f` -- should show error message, overlay should close gracefully
12. **Error case:** Try cloning a repo that already exists locally -- should show appropriate error

### Validation Commands

```bash
cd tui
bun test                    # All unit tests pass
bun run typecheck           # No TypeScript errors
bun run lint                # No Biome linter errors
bun run build               # Build succeeds
```

## Definition of Done

- [ ] All 8 subtasks completed
- [ ] All new and existing tests passing (`bun test`)
- [ ] TypeScript type check clean (`bun run typecheck`)
- [ ] Biome linter clean (`bun run lint`)
- [ ] Build succeeds (`bun run build`)
- [ ] Code follows project conventions (named exports, JSDoc comments, 2-space indent, `import type`)
- [ ] Manual testing confirms:
  - [ ] `f` opens the repo browser overlay
  - [ ] Repos load without blocking the UI
  - [ ] Filter narrows the list in real-time
  - [ ] [INSTALLED] / [CLONE] badges are correct
  - [ ] Clone operation shows ActivityOverlay spinner
  - [ ] Successful clone updates both the overlay badge and the Repositories panel
  - [ ] `Esc` closes the overlay cleanly
  - [ ] Error states are handled gracefully (no crashes, informative messages)
- [ ] HelpDialog shows the new `f` shortcut
- [ ] StatusBar shows `f: fetch repo` in key hints

## Appendix: File Change Summary

| File | Action | Description |
|------|--------|-------------|
| `tui/src/types/github.ts` | NEW | `RemoteRepo`, `BrowsableRepo`, `RepoAvailability` types |
| `tui/src/services/GitHubService.ts` | NEW | GitHub repo discovery + clone service |
| `tui/src/commands/CloneRepoCommand.ts` | NEW | Clone command implementing Command pattern |
| `tui/src/components/RepoBrowser.tsx` | NEW | Full-screen overlay for browsing/cloning repos |
| `tui/src/state/actions.ts` | MODIFY | Add 5 new action types |
| `tui/src/state/appReducer.ts` | MODIFY | Add 3 new state fields + 5 reducer cases |
| `tui/src/state/AppContext.tsx` | MODIFY | Add `github: GitHubService` to `Services` |
| `tui/src/index.tsx` | MODIFY | Instantiate `GitHubService`, add to services |
| `tui/src/App.tsx` | MODIFY | Add overlay rendering, callbacks, keyboard wiring |
| `tui/src/hooks/useKeyboardShortcuts.ts` | MODIFY | Add `f` shortcut + `showRepoBrowser` guard |
| `tui/src/components/HelpDialog.tsx` | MODIFY | Add `f` to shortcuts list |
| `tui/src/components/StatusBar.tsx` | MODIFY | Add `f: fetch repo` to key hints |
| `tui/src/types/activity.ts` | MODIFY | Add `"clone-repo"` to `ActivityKind` |
| `tui/src/__tests__/services/GitHubService.test.ts` | NEW | Service unit tests |
| `tui/src/__tests__/commands/CloneRepoCommand.test.ts` | NEW | Command unit tests |
| `tui/src/__tests__/state/appReducer.test.ts` | MODIFY | Tests for new actions |
