# Swarm Modules - Bricks and Studs Design

## Philosophy

Following the **"bricks and studs"** philosophy from `MODULAR_DESIGN_PHILOSOPHY.md`:

- Each **brick** = self-contained module with clear responsibility
- Each **stud** = public contract (interface) other modules use
- Modules are **regeneratable** from their specifications
- Contracts remain **stable** while implementations can evolve

## Module Overview

```
┌─────────────────────────────────────────────────────────────┐
│                         CLI Layer                           │
│  (cmd/*) - User-facing commands                             │
└───────────────────────┬─────────────────────────────────────┘
                        │
        ┌───────────────┼───────────────┬───────────────┐
        │               │               │               │
┌───────▼──────┐ ┌──────▼──────┐ ┌────▼──────┐ ┌──────▼─────┐
│  repo        │ │  worktree   │ │   tmux    │ │   state    │
│  (discovery) │ │  (lifecycle)│ │ (session) │ │  (persist) │
└───────┬──────┘ └──────┬──────┘ └────┬──────┘ └──────┬─────┘
        │               │               │               │
        └───────────────┼───────────────┴───────────────┘
                        │
                ┌───────▼──────┐
                │     git      │
                │  (exec/parse)│
                └──────────────┘
```

## Module Catalog

### 1. repo (Repository Discovery)

**Brick:** `internal/repo/`
**Responsibility:** Discover and validate Git repositories in `$AI_WORKING_DIR`

**Public Contract (Studs):**
```go
package repo

// Discovery scans for repositories
type Discovery interface {
    // ScanAll finds all repos under $AI_WORKING_DIR
    ScanAll() ([]Repo, error)

    // FindByName finds specific repo by name
    FindByName(name string) (*Repo, error)

    // Refresh rebuilds the repo cache
    Refresh() error
}

// Repo represents a base repository
type Repo struct {
    Name          string    // e.g., "my-project"
    Path          string    // absolute path
    DefaultBranch string    // "main", "master", etc.
    LastScanned   time.Time
}
```

**Implementation Notes:**
- Parallel scanning with worker pool (see ARCHITECTURE.md performance section)
- Cache results in memory for duration of command
- Validate .git exists and is accessible

**Dependencies:**
- Uses `git` module for branch detection
- Uses `config` module for `AI_WORKING_DIR` location

**Testing:**
- Unit: Mock filesystem, test glob patterns
- Integration: Real temp directories with git repos

---

### 2. worktree (Worktree Lifecycle)

**Brick:** `internal/worktree/`
**Responsibility:** CRUD operations for Git worktrees

**Public Contract (Studs):**
```go
package worktree

// Manager handles worktree operations
type Manager interface {
    // List returns all worktrees for a repo
    List(repo *repo.Repo) ([]Worktree, error)

    // Create creates new worktree
    Create(repo *repo.Repo, opts CreateOptions) (*Worktree, error)

    // Find locates worktree by branch or slug
    Find(repo *repo.Repo, identifier string) (*Worktree, error)

    // Remove deletes worktree (after safety checks)
    Remove(wt *Worktree, force bool) error

    // Prune removes stale worktree references
    Prune(repo *repo.Repo) error
}

// Worktree represents a git worktree
type Worktree struct {
    Repo      *repo.Repo
    Branch    string              // "feature/payments"
    Slug      string              // "feature_payments"
    Path      string              // absolute path to worktree
    IsDetached bool               // HEAD detached?
    CreatedAt  time.Time
    LastOpened time.Time
    Status    *WorktreeStatus     // lazy-loaded
}

// CreateOptions for Create()
type CreateOptions struct {
    Branch     string  // Branch to create/use
    BaseBranch string  // Create from (e.g., "main")
    CustomSlug string  // Override slug generation
    NoSession  bool    // Skip tmux session creation
}

// WorktreeStatus represents computed status (expensive)
type WorktreeStatus struct {
    Modified  bool   // Has uncommitted changes
    Unpushed  bool   // Has unpushed commits
    Merged    *bool  // Branch merged? (nil = unknown)
    Orphaned  bool   // In state but not in git
}
```

**Sub-modules:**

```go
// internal/worktree/slug.go
package worktree

// SlugGenerator creates filesystem-safe slugs
type SlugGenerator interface {
    Generate(branch string) string
    GenerateUnique(branch string, existing map[string]string) string
}
```

**Implementation Notes:**
- Slug collision detection (see ADR-007)
- Path validation (prevent traversal)
- Lazy status evaluation (cache with TTL)

**Dependencies:**
- `git` for worktree commands
- `state` for metadata persistence
- `tmux` for session creation (if requested)
- `safety` for removal validation

**Testing:**
- Unit: Slug generation, path validation
- Integration: Real git repos, create/remove cycles

---

### 3. tmux (Session Management)

**Brick:** `internal/tmux/`
**Responsibility:** Tmux session lifecycle and layout

**Public Contract (Studs):**
```go
package tmux

// SessionManager handles tmux sessions
type SessionManager interface {
    // Exists checks if session exists
    Exists(name string) (bool, error)

    // Create creates new detached session
    Create(opts CreateOptions) error

    // Attach attaches to session (or switches if inside tmux)
    Attach(name string) error

    // Kill terminates session
    Kill(name string) error

    // List returns all sessions
    List() ([]Session, error)
}

// Session represents a tmux session
type Session struct {
    Name      string
    Path      string  // Working directory
    Windows   []Window
    Attached  bool
    CreatedAt time.Time
}

// CreateOptions for Create()
type CreateOptions struct {
    Name   string
    Path   string
    Layout *Layout  // Optional custom layout
}

// Layout defines window/pane structure
type Layout struct {
    Windows []WindowDef
}

type WindowDef struct {
    Name    string
    Command string  // Initial command
    Panes   []PaneDef
}

type PaneDef struct {
    Command string
    Split   string  // "horizontal", "vertical"
}
```

**Implementation Notes:**
- Detect if inside tmux (use `switch-client` vs `attach`)
- Default layout: 3 windows (editor, shell, tests)
- User-configurable layouts via config/script

**Dependencies:**
- None (pure tmux command wrapper)

**Testing:**
- Unit: Command building, name validation
- Integration: Real tmux (requires tmux installed)

---

### 4. state (State Persistence)

**Brick:** `internal/state/`
**Responsibility:** Read/write/reconcile state file

**Public Contract (Studs):**
```go
package state

// Store manages state persistence
type Store interface {
    // Load reads entire state from disk
    Load() (*State, error)

    // Save writes entire state atomically
    Save(state *State) error

    // UpdateWorktree updates single worktree
    UpdateWorktree(repo string, wt *worktree.Worktree) error

    // RemoveWorktree removes worktree from state
    RemoveWorktree(repo string, slug string) error

    // Reconcile syncs state with git reality
    Reconcile(repo *repo.Repo, gitWorktrees []worktree.Worktree) error
}

// State represents the entire state file
type State struct {
    Version   int                     `json:"version"`
    UpdatedAt time.Time               `json:"updated_at"`
    Repos     map[string]*RepoState   `json:"repos"`
}

// RepoState represents state for one repo
type RepoState struct {
    Path          string                       `json:"path"`
    DefaultBranch string                       `json:"default_branch"`
    LastScanned   time.Time                    `json:"last_scanned"`
    Worktrees     map[string]*WorktreeState    `json:"worktrees"`
}

// WorktreeState represents persisted worktree metadata
type WorktreeState struct {
    Slug         string    `json:"slug"`
    Branch       string    `json:"branch"`
    Path         string    `json:"path"`
    CreatedAt    time.Time `json:"created_at"`
    LastOpenedAt time.Time `json:"last_opened_at"`
    TmuxSession  string    `json:"tmux_session"`
}
```

**Sub-modules:**

```go
// internal/state/lock.go
package state

// Locker provides file locking
type Locker interface {
    Lock() error
    Unlock() error
    TryLock() (bool, error)
}
```

**Implementation Notes:**
- File path: `$AI_WORKING_DIR/.swarm-state.json`
- Atomic writes: write to `.swarm-state.json.tmp` then rename
- File locking with `gofrs/flock`
- Reconciliation strategy (see ADR-004)

**Dependencies:**
- `config` for state file location
- `worktree` types (but not logic)

**Testing:**
- Unit: JSON marshaling, atomic write logic
- Integration: Concurrent access with locking

---

### 5. config (Configuration)

**Brick:** `internal/config/`
**Responsibility:** Load and merge configuration from multiple sources

**Public Contract (Studs):**
```go
package config

// Config represents merged configuration
type Config struct {
    AIWorkingDir         string
    DefaultBaseBranch    string
    WorktreePattern      string  // "patternA", "patternB", "patternC"
    CreateSessionOnCreate bool
    TmuxLayoutScript     string
    StatusCacheTTL       time.Duration
    PreferFzf            bool
    AutoPruneOnRemove    bool
}

// Loader loads and merges config
type Loader interface {
    // Load merges env vars, user config, project config
    Load() (*Config, error)

    // Get retrieves specific config value
    Get(key string) (interface{}, error)

    // Set updates config value (persists to user config)
    Set(key string, value interface{}) error
}
```

**Configuration Precedence:**
1. Environment variables (e.g., `SWARM_AI_WORKING_DIR`)
2. User config (`~/.config/swarm/config.yml`)
3. Project config (`$AI_WORKING_DIR/.swarmrc`)
4. Built-in defaults

**Example config.yml:**
```yaml
ai_working_dir: ~/amplifier/ai_working
default_base_branch: main
worktree_pattern: patternA
create_session_on_create: true
tmux_layout_script: ~/.config/swarm/layout.sh
status_cache_ttl: 30s
prefer_fzf: false
auto_prune_on_remove: true
```

**Implementation Notes:**
- Use `spf13/viper` for multi-source config
- XDG Base Directory spec for config location
- Validate config on load

**Dependencies:**
- None (foundational module)

**Testing:**
- Unit: Config merging precedence
- Integration: Load from real files

---

### 6. safety (Safety Checks)

**Brick:** `internal/safety/`
**Responsibility:** Validate operations are safe

**Public Contract (Studs):**
```go
package safety

// Checker validates operation safety
type Checker interface {
    // CheckRemoval validates worktree can be safely removed
    CheckRemoval(wt *worktree.Worktree) (*CheckResult, error)

    // CheckSwitch validates branch switch is safe
    CheckSwitch(wt *worktree.Worktree, targetBranch string) (*CheckResult, error)
}

// CheckResult represents safety check outcome
type CheckResult struct {
    Safe     bool       // Can proceed without --force?
    Blockers []string   // Fatal issues (require --force)
    Warnings []string   // Non-fatal issues (inform user)
}

// Error types for blockers
var (
    ErrUncommittedChanges = errors.New("uncommitted changes")
    ErrUnpushedCommits    = errors.New("unpushed commits")
    ErrUnmergedBranch     = errors.New("branch not merged")
)
```

**Implementation Notes:**
- Check uncommitted: `git status --porcelain`
- Check unpushed: `git log origin/branch..HEAD`
- Check merged: `git branch --contains branch | grep main`
- Cache results briefly (TTL: 10s)

**Dependencies:**
- `git` for status commands
- `worktree` types

**Testing:**
- Unit: Mock git output
- Integration: Real repos with dirty state

---

### 7. git (Git Command Wrapper)

**Brick:** `internal/git/`
**Responsibility:** Execute and parse git commands

**Public Contract (Studs):**
```go
package git

// Client executes git commands
type Client interface {
    // WorktreeList lists all worktrees for repo
    WorktreeList(repoPath string) ([]WorktreeInfo, error)

    // WorktreeAdd creates new worktree
    WorktreeAdd(repoPath string, opts AddOptions) error

    // WorktreeRemove deletes worktree
    WorktreeRemove(repoPath, worktreePath string) error

    // WorktreePrune removes stale refs
    WorktreePrune(repoPath string) error

    // FetchAll fetches from all remotes
    FetchAll(repoPath string) error

    // Status returns working tree status
    Status(path string) (*StatusResult, error)

    // Log returns commit log
    Log(path, revRange string) ([]Commit, error)

    // DefaultBranch detects default branch (main, master, etc.)
    DefaultBranch(repoPath string) (string, error)
}

// WorktreeInfo from git worktree list --porcelain
type WorktreeInfo struct {
    Path      string
    Branch    string
    Commit    string
    Detached  bool
}

// AddOptions for WorktreeAdd
type AddOptions struct {
    Path       string
    Branch     string
    BaseBranch string  // Create from this branch
    NewBranch  bool    // Create new branch?
}

// StatusResult from git status --porcelain
type StatusResult struct {
    Modified  []string
    Added     []string
    Deleted   []string
    Untracked []string
}

// Commit represents a git commit
type Commit struct {
    Hash    string
    Message string
    Author  string
    Date    time.Time
}
```

**Sub-modules:**

```go
// internal/git/parser.go
package git

// Parser parses git command output
type Parser interface {
    ParseWorktreeList(output string) ([]WorktreeInfo, error)
    ParseStatus(output string) (*StatusResult, error)
    ParseLog(output string) ([]Commit, error)
}
```

**Implementation Notes:**
- All git commands via `exec.Command`
- Parse --porcelain formats (machine-readable)
- Error context includes stderr output
- No direct .git manipulation

**Dependencies:**
- None (foundational module)

**Testing:**
- Unit: Parser with fixture output
- Integration: Real git repos

---

### 8. tui (Terminal UI)

**Brick:** `internal/tui/`
**Responsibility:** Interactive terminal interface

**Public Contract (Studs):**
```go
package tui

// App is the main TUI application
type App interface {
    // Run starts the TUI
    Run() error
}

// Model is the Bubble Tea model
type Model struct {
    repos     ReposModel
    worktrees WorktreesModel
    detail    DetailModel
    focus     Focus
    err       error
}

// Focus indicates which panel is active
type Focus int
const (
    FocusRepos Focus = iota
    FocusWorktrees
    FocusDetail
)
```

**Sub-models (separate files):**

```go
// internal/tui/repos.go
type ReposModel struct {
    list   list.Model  // From bubbles
    repos  []repo.Repo
    filter string
}

// internal/tui/worktrees.go
type WorktreesModel struct {
    list      list.Model
    worktrees []worktree.Worktree
    selected  *worktree.Worktree
}

// internal/tui/detail.go
type DetailModel struct {
    worktree *worktree.Worktree
    status   *worktree.WorktreeStatus
}
```

**Key Bindings:**
- `q`: Quit
- `tab`/`shift-tab`: Switch focus
- `/`: Filter
- `r`: Refresh
- `n`: New worktree
- `o`/`enter`: Open/attach
- `d`: Delete
- `?`: Help

**Implementation Notes:**
- Elm Architecture (Model-Update-View)
- Use `bubbles` components (list, viewport, etc.)
- Async status loading (spinner while computing)

**Dependencies:**
- `repo`, `worktree`, `tmux`, `state` (for data)
- Bubble Tea framework

**Testing:**
- Unit: Update logic with mock messages
- Integration: Difficult (TUI), focus on command layer

---

## Module Dependencies Graph

```
         config
         /    \
      repo    state
        \      /  \
       worktree   \
        /  \  \    \
     git  tmux  safety
```

**Key:**
- `config` has no dependencies (foundational)
- `git` has no dependencies (foundational)
- `repo` uses `git`, `config`
- `worktree` uses `git`, `state`, `tmux`, `safety`, `repo`
- `state` uses `config`
- `safety` uses `git`
- `tmux` is independent

## Regeneration Strategy

Each module can be regenerated from its specification above without breaking other modules:

1. **Contract is stable** - Public interfaces don't change
2. **Internal implementation can evolve** - Optimize, refactor, rewrite
3. **Tests validate contract** - If tests pass, integration works

### Example: Regenerating `slug.go`

**Specification:**
```
Generate filesystem-safe slug from branch name:
- Replace / with _
- Remove non-alphanumeric (except - and _)
- Handle collisions with numeric suffix
- Max length 80 chars
```

**Original implementation:**
```go
func GenerateSlug(branch string) string {
    return strings.ReplaceAll(branch, "/", "_")
}
```

**Regenerated (optimized):**
```go
var slugRegex = regexp.MustCompile(`[^a-zA-Z0-9_-]+`)

func GenerateSlug(branch string) string {
    slug := strings.ReplaceAll(branch, "/", "_")
    slug = slugRegex.ReplaceAllString(slug, "_")
    if len(slug) > 80 {
        slug = slug[:80]
    }
    return strings.Trim(slug, "_")
}
```

**Contract preserved:**
- Input: `string` (branch name)
- Output: `string` (safe slug)
- Behavior: Deterministic, filesystem-safe

**Tests still pass:**
```go
func TestGenerateSlug(t *testing.T) {
    assert.Equal(t, "feature_foo", GenerateSlug("feature/foo"))
    assert.Equal(t, "bug_fix-123", GenerateSlug("bug/fix-123"))
}
```

## Building Sequence

Recommended implementation order (respects dependencies):

1. **Phase 1: Foundation**
   - `config` (no deps)
   - `git` (no deps)
   - `state` (needs config)

2. **Phase 2: Core Logic**
   - `repo` (needs git, config)
   - `worktree/slug` (no deps)
   - `worktree/manager` (needs git, repo)
   - `safety` (needs git)

3. **Phase 3: Integration**
   - `tmux` (independent)
   - `worktree` complete (add tmux integration)
   - `state` reconciliation

4. **Phase 4: Interface**
   - `cmd/*` (CLI commands)
   - `tui` (interactive UI)

## Testing Each Module

### Unit Tests (Brick in Isolation)

```go
// internal/worktree/slug_test.go
func TestSlugGeneration(t *testing.T) {
    tests := []struct{
        branch string
        want   string
    }{
        {"feature/foo", "feature_foo"},
        {"bug/fix-123", "bug_fix-123"},
    }

    for _, tt := range tests {
        got := GenerateSlug(tt.branch)
        assert.Equal(t, tt.want, got)
    }
}
```

### Integration Tests (Bricks Together)

```go
// internal/worktree/manager_test.go
func TestCreateWorktree(t *testing.T) {
    // Setup
    tmpDir := t.TempDir()
    setupGitRepo(tmpDir, "test-repo")

    // Create manager
    mgr := NewManager(git.NewClient(), state.NewStore())

    // Execute
    repo := &repo.Repo{Path: tmpDir + "/test-repo"}
    wt, err := mgr.Create(repo, CreateOptions{
        Branch: "feature/test",
        BaseBranch: "main",
    })

    // Verify
    require.NoError(t, err)
    assert.DirExists(t, wt.Path)
    assert.Equal(t, "feature_test", wt.Slug)

    // Verify git knows about it
    list, _ := git.WorktreeList(repo.Path)
    assert.Contains(t, list, wt.Path)
}
```

## Documentation Requirements

Each module requires:

1. **README.md** in module directory:
   ```markdown
   # Module Name
   ## Purpose
   ## Public Contract (Studs)
   ## Dependencies
   ## Usage Examples
   ## Testing
   ```

2. **Godoc comments** on all public types/functions
3. **Examples** in `_test.go` files

## Module Checklist

Before considering a module "complete":

- [ ] README.md written
- [ ] Public contract defined (interface)
- [ ] Implementation complete
- [ ] Unit tests (>80% coverage)
- [ ] Integration tests (happy path + error cases)
- [ ] Godoc comments
- [ ] Examples in tests
- [ ] No unexported coupling (only via public contract)

## Future Modules (Extensibility)

These modules are not in MVP but prepared for:

### hooks (Plugin System)

```go
package hooks

type Hook interface {
    Execute(event string, ctx Context) error
}

type Context struct {
    Repo   string
    Branch string
    Path   string
    Env    map[string]string
}
```

### layout (Tmux Layout Templates)

```go
package layout

type LayoutManager interface {
    Load(name string) (*Layout, error)
    Save(name string, layout *Layout) error
    Apply(session string, layout *Layout) error
}
```

### query (Worktree Query Language)

```go
package query

type Query interface {
    Execute(expr string) ([]worktree.Worktree, error)
}

// Examples:
// "branch:feature/*"
// "age:>7d"
// "status:modified"
```

## Summary

Each module ("brick") has:
- **Clear purpose** - Single responsibility
- **Stable contract** ("studs") - Public interface
- **Internal freedom** - Implementation can evolve
- **Isolation** - Can be tested alone
- **Regeneration** - Can be rebuilt from spec

This design enables:
- **Parallel development** - Different people/agents work on different modules
- **Safe refactoring** - Regenerate internals without breaking system
- **Easy testing** - Mock dependencies via interfaces
- **Clear ownership** - Each module has defined scope
