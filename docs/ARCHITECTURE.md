# Swarm Architecture

## Overview

Swarm is a Git worktree + tmux session management tool designed for parallel development workflows within the `amplifier/ai_working/` directory structure. It follows the "bricks and studs" philosophy with self-contained, regeneratable modules.

## Technology Stack Decision

### Language: Go

**Rationale:**
- Single static binary deployment (no runtime dependencies)
- Fast startup time (<100ms target)
- Excellent TUI framework (Bubble Tea) with mature ecosystem
- Strong standard library for process management (exec, os)
- Good balance of development velocity and performance
- Easy cross-compilation for different platforms

**Alternatives Considered:**
- **Rust + ratatui**: Higher performance but slower iteration, steeper learning curve
- **Python + Textual**: Fastest iteration but startup overhead, distribution complexity

### TUI Framework: Bubble Tea

**Rationale:**
- Battle-tested (used in many production CLIs)
- Elm Architecture pattern (predictable state management)
- Rich component library (Bubbles) for common UI patterns
- Active community and documentation
- Clean separation of concerns (Model-Update-View)

### CLI Framework: Cobra

**Rationale:**
- Industry standard for Go CLIs (kubectl, hugo, etc.)
- Built-in command hierarchy and flag parsing
- Auto-generated help and documentation
- Shell completion support (bash, zsh, fish)

## Core Architecture

### System Layers

```
┌─────────────────────────────────────────────┐
│           CLI Layer (Cobra)                 │
│  Commands: create, open, list, remove, etc.│
└─────────────────┬───────────────────────────┘
                  │
┌─────────────────▼───────────────────────────┐
│         Application Layer                   │
│  • Orchestration logic                      │
│  • Command routing                          │
│  • Error handling                           │
└─────────────────┬───────────────────────────┘
                  │
┌─────────────────▼───────────────────────────┐
│          Domain Layer                       │
│  • repo_discovery                           │
│  • worktree_manager                         │
│  • tmux_manager                             │
│  • state_store                              │
│  • config                                   │
│  • safety_checker                           │
└─────────────────┬───────────────────────────┘
                  │
┌─────────────────▼───────────────────────────┐
│        Infrastructure Layer                 │
│  • Git command execution                    │
│  • Tmux command execution                   │
│  • File system operations                   │
│  • State persistence (JSON)                 │
└─────────────────────────────────────────────┘
```

### Module Structure

Following the "bricks and studs" philosophy, each module is:
1. **Self-contained**: Has its own directory with clear boundaries
2. **Single responsibility**: Does one thing well
3. **Clear contract**: Exposes only public interface
4. **Testable in isolation**: Can be tested without other modules
5. **Regeneratable**: Can be rebuilt from specification without breaking contracts

```
swarm/
├── cmd/                    # CLI commands (brick)
│   ├── root.go            # Root command
│   ├── create.go          # Create worktree
│   ├── open.go            # Open/attach session
│   ├── list.go            # List worktrees
│   ├── remove.go          # Remove worktree
│   ├── tui.go             # Launch TUI
│   └── ...
├── internal/
│   ├── repo/              # Repo discovery (brick)
│   │   ├── discovery.go   # Scan ai_working/
│   │   └── models.go      # Repo data structures
│   ├── worktree/          # Worktree manager (brick)
│   │   ├── manager.go     # CRUD operations
│   │   ├── slug.go        # Name sanitization
│   │   └── models.go      # Worktree data structures
│   ├── tmux/              # Tmux manager (brick)
│   │   ├── session.go     # Session lifecycle
│   │   ├── layout.go      # Window/pane setup
│   │   └── models.go      # Session data structures
│   ├── state/             # State persistence (brick)
│   │   ├── store.go       # Read/write state
│   │   ├── lock.go        # File locking
│   │   └── models.go      # State data structures
│   ├── config/            # Configuration (brick)
│   │   ├── config.go      # Load/merge config
│   │   └── models.go      # Config data structures
│   ├── safety/            # Safety checks (brick)
│   │   ├── checker.go     # Pre-remove validations
│   │   └── models.go      # Check result structures
│   ├── git/               # Git wrapper (brick)
│   │   ├── client.go      # Command execution
│   │   └── parser.go      # Output parsing
│   └── tui/               # Terminal UI (brick)
│       ├── app.go         # Main app model
│       ├── repos.go       # Repos list view
│       ├── worktrees.go   # Worktrees list view
│       ├── detail.go      # Detail pane view
│       └── commands.go    # Command palette
├── pkg/                   # Public utilities
│   └── types/             # Shared types
└── docs/                  # Documentation
    ├── ARCHITECTURE.md    # This file
    ├── DECISIONS.md       # ADRs
    └── plans/             # Implementation plans
```

## Data Flow

### Create Worktree Flow

```
User: swarm create my-project feature/foo --from main
  │
  ├─> cmd.create.Execute()
  │     │
  │     ├─> repo.Discovery.FindRepo("my-project")
  │     │     └─> Scans $REPOS_DIR for matching repo
  │     │
  │     ├─> worktree.Manager.Create(repo, branch, base)
  │     │     ├─> worktree.Slug.Generate(branch)
  │     │     │     └─> "feature_foo"
  │     │     ├─> git.Client.FetchAll(repo)
  │     │     └─> git.Client.WorktreeAdd(path, branch, base)
  │     │
  │     ├─> state.Store.AddWorktree(repo, worktree)
  │     │     ├─> state.Lock.Acquire()
  │     │     ├─> state.Store.Load()
  │     │     ├─> state.Store.Update(worktree)
  │     │     ├─> state.Store.Save()
  │     │     └─> state.Lock.Release()
  │     │
  │     └─> tmux.Session.Create(name, path, layout)
  │           └─> tmux.Client.NewSession(name, path)
  │
  └─> Success: "Created worktree my-project__wt__feature_foo"
```

### Open Worktree Flow

```
User: swarm open my-project feature/foo
  │
  ├─> cmd.open.Execute()
  │     │
  │     ├─> repo.Discovery.FindRepo("my-project")
  │     │
  │     ├─> worktree.Manager.Find(repo, "feature/foo")
  │     │     ├─> git.Client.WorktreeList(repo)
  │     │     └─> Match by branch name
  │     │
  │     ├─> state.Store.UpdateLastOpened(worktree)
  │     │
  │     └─> tmux.Session.AttachOrCreate(name, path)
  │           ├─> tmux.Client.HasSession(name)?
  │           ├─> Yes: tmux.Client.Attach(name)
  │           └─> No: tmux.Client.NewSession(name, path)
  │                 └─> tmux.Client.Attach(name)
  │
  └─> Attached to tmux session
```

### Remove Worktree Flow (with safety checks)

```
User: swarm remove my-project feature/foo
  │
  ├─> cmd.remove.Execute()
  │     │
  │     ├─> worktree.Manager.Find(repo, branch)
  │     │
  │     ├─> safety.Checker.ValidateRemoval(worktree)
  │     │     ├─> git.Client.Status(path) → Has uncommitted?
  │     │     ├─> git.Client.Log(path) → Has unpushed?
  │     │     └─> Return CheckResult{Safe, Warnings}
  │     │
  │     ├─> If unsafe && !force:
  │     │     └─> Display warnings, exit(40)
  │     │
  │     ├─> tmux.Session.Kill(name) [ignore if missing]
  │     │
  │     ├─> git.Client.WorktreeRemove(path)
  │     │
  │     └─> state.Store.RemoveWorktree(repo, worktree)
  │
  └─> Success: "Removed worktree and session"
```

## State Management

### State File Structure

Location: `$REPOS_DIR/.swarm-state.json`

```json
{
  "version": 1,
  "updated_at": "2025-11-10T14:30:00Z",
  "repos": {
    "my-project": {
      "path": "/Users/danny/amplifier/ai_working/my-project",
      "default_branch": "main",
      "last_scanned": "2025-11-10T14:29:55Z",
      "worktrees": {
        "feature_payments-refactor": {
          "slug": "feature_payments-refactor",
          "branch": "feature/payments-refactor",
          "path": "/Users/danny/amplifier/ai_working/my-project__wt__feature_payments-refactor",
          "created_at": "2025-11-10T10:00:00Z",
          "last_opened_at": "2025-11-10T14:25:00Z",
          "tmux_session": "my-project--wt--feature_payments-refactor"
        }
      }
    }
  }
}
```

### State Reconciliation

On every operation, reconcile state with git reality:

1. **Load state file** (cached metadata)
2. **Query git worktree list** (source of truth)
3. **Compare**:
   - State has worktree but git doesn't → Mark orphaned
   - Git has worktree but state doesn't → Add to state
4. **Update state** atomically

### Concurrency Safety

**File locking strategy:**
```go
// Acquire exclusive lock
lockFile := filepath.Join(stateDir, ".swarm-state.lock")
lock := flock.New(lockFile)
err := lock.Lock()
defer lock.Unlock()

// Safe to read/modify/write state
```

## Naming Conventions

### Worktree Directory Pattern

**Pattern A (Default):** Flat sibling cluster
```
ai_working/
├── my-project/              # Base repo
├── my-project__wt__main/    # Worktree for main
├── my-project__wt__feature_foo/
└── my-project__wt__bugfix_bar/
```

**Benefits:**
- First-class visibility for AI tools
- Easy to discover
- Simple to clean up
- No nesting complexity

### Slug Generation

```go
func GenerateSlug(branch string) string {
    // feature/payments-refactor → feature_payments-refactor
    slug := strings.ReplaceAll(branch, "/", "_")

    // Sanitize for filesystem
    slug = regexp.MustCompile(`[^a-zA-Z0-9_-]`).ReplaceAllString(slug, "_")

    // Handle collisions
    if exists(slug) {
        slug = slug + "_2"  // Append suffix
    }

    return slug
}
```

### Tmux Session Naming

```
Format: <repo-slug>--wt--<worktree-slug>
Example: my-project--wt--feature_payments-refactor

Rules:
- Alphanumeric + hyphens + underscores only
- Must be unique per worktree
- Max 80 characters (tmux limit: 96)
```

## Error Handling

### Error Categories

1. **User Input Errors** (exit 10)
   - Invalid repo name
   - Invalid branch name
   - Missing required arguments

2. **Git Errors** (exit 20)
   - Git not installed
   - Not a git repository
   - Branch doesn't exist
   - Worktree already exists

3. **Tmux Errors** (exit 30)
   - Tmux not installed
   - Session creation failed
   - Attach failed

4. **Safety Check Blocked** (exit 40)
   - Uncommitted changes
   - Unpushed commits
   - User must use --force

5. **State Errors** (exit 50)
   - Cannot acquire lock
   - State file corrupted
   - Cannot write state

### Error Handling Strategy

```go
// Wrap errors with context
if err != nil {
    return fmt.Errorf("creating worktree for %s: %w", branch, err)
}

// Provide actionable messages
if errors.Is(err, ErrUncommittedChanges) {
    return &SafetyError{
        Message: "Worktree has uncommitted changes",
        Advice: "Run 'git status' in the worktree or use --force to remove anyway",
        ExitCode: 40,
    }
}
```

## Performance Considerations

### Scanning Strategy

**Problem:** Scanning large directories is slow

**Solution:** Parallel scanning with worker pool
```go
repos := make(chan string, 10)
results := make(chan Repo, 10)

// Worker pool
for w := 0; w < runtime.NumCPU(); w++ {
    go worker(repos, results)
}

// Distribute work
go func() {
    for _, dir := range subdirs {
        repos <- dir
    }
    close(repos)
}()
```

### Lazy Status Evaluation

**Problem:** Git status checks are expensive

**Solution:** Compute only when needed
```go
type Worktree struct {
    // ... other fields

    status     *WorktreeStatus  // Cached, lazy-loaded
    statusAge  time.Time        // When was it computed
    statusTTL  time.Duration    // How long is it valid
}

func (w *Worktree) Status() (*WorktreeStatus, error) {
    if w.status != nil && time.Since(w.statusAge) < w.statusTTL {
        return w.status, nil  // Use cached
    }

    // Recompute
    status, err := ComputeStatus(w)
    if err != nil {
        return nil, err
    }

    w.status = status
    w.statusAge = time.Now()
    return status, nil
}
```

### State File Optimization

**Problem:** Loading large state files is slow

**Solution:** Memory-mapped file + incremental updates
```go
// Only load what's needed
func LoadRepoState(repoName string) (*RepoState, error) {
    // Parse JSON incrementally, extract only repoName section
}

// Partial updates
func UpdateWorktreeState(repoName, slug string, update func(*Worktree)) error {
    // Load → Update slice → Write
}
```

## Security Considerations

### Path Validation

**Prevent path traversal:**
```go
func ValidatePath(base, target string) error {
    abs, err := filepath.Abs(target)
    if err != nil {
        return err
    }

    rel, err := filepath.Rel(base, abs)
    if err != nil || strings.HasPrefix(rel, "..") {
        return ErrPathEscaped
    }

    return nil
}
```

### Tmux Session Name Sanitization

**Prevent injection:**
```go
func SanitizeSessionName(name string) string {
    // Allow: alphanumeric, hyphen, underscore
    sanitized := regexp.MustCompile(`[^a-zA-Z0-9_-]`).ReplaceAllString(name, "_")

    // Truncate to tmux limit
    if len(sanitized) > 80 {
        sanitized = sanitized[:80]
    }

    return sanitized
}
```

## Extensibility

### Hook System (Phase 4)

```go
type Hook struct {
    Event   string   // "post-create", "pre-remove", etc.
    Command string   // Executable path
    Env     []string // Environment variables
}

func ExecuteHook(event string, ctx HookContext) error {
    hooks := config.GetHooks(event)
    for _, hook := range hooks {
        cmd := exec.Command(hook.Command)
        cmd.Env = append(os.Environ(), hook.Env...)
        cmd.Env = append(cmd.Env,
            fmt.Sprintf("SWARM_REPO=%s", ctx.Repo),
            fmt.Sprintf("SWARM_BRANCH=%s", ctx.Branch),
            fmt.Sprintf("SWARM_PATH=%s", ctx.Path),
        )

        if err := cmd.Run(); err != nil {
            return fmt.Errorf("hook %s failed: %w", hook.Command, err)
        }
    }
    return nil
}
```

## Testing Strategy

### Unit Tests

Test each module in isolation:
```go
func TestSlugGeneration(t *testing.T) {
    tests := []struct{
        branch string
        want   string
    }{
        {"feature/foo", "feature_foo"},
        {"bug/fix-123", "bug_fix-123"},
        {"main", "main"},
    }

    for _, tt := range tests {
        got := GenerateSlug(tt.branch)
        if got != tt.want {
            t.Errorf("GenerateSlug(%q) = %q, want %q",
                tt.branch, got, tt.want)
        }
    }
}
```

### Integration Tests

Test module interactions:
```go
func TestCreateAndOpenFlow(t *testing.T) {
    // Setup temp workspace
    workDir := t.TempDir()
    setupFakeRepo(workDir, "test-repo")

    // Create worktree
    wt, err := manager.Create("test-repo", "feature/test", "main")
    require.NoError(t, err)

    // Verify directory exists
    assert.DirExists(t, wt.Path)

    // Verify git knows about it
    list, err := git.WorktreeList(workDir + "/test-repo")
    require.NoError(t, err)
    assert.Contains(t, list, wt.Path)

    // Open session
    sess, err := tmux.AttachOrCreate(wt.SessionName(), wt.Path)
    require.NoError(t, err)

    // Verify session exists
    exists, _ := tmux.HasSession(sess)
    assert.True(t, exists)

    // Cleanup
    tmux.KillSession(sess)
    manager.Remove(wt, false)
}
```

### End-to-End Tests

Test via CLI:
```bash
#!/usr/bin/env bash
set -euo pipefail

# Setup
WORK_DIR=$(mktemp -d)
export REPOS_DIR="$WORK_DIR"
git init "$WORK_DIR/test-repo"

# Test create
swarm create test-repo feature/e2e --from main
assert_dir_exists "$WORK_DIR/test-repo__wt__feature_e2e"

# Test list
output=$(swarm list test-repo --json)
assert_contains "$output" "feature/e2e"

# Test open
swarm open test-repo feature/e2e --attach-only
assert_tmux_session_exists "test-repo--wt--feature_e2e"

# Test remove
swarm remove test-repo feature/e2e --force
assert_dir_not_exists "$WORK_DIR/test-repo__wt__feature_e2e"
assert_tmux_session_not_exists "test-repo--wt--feature_e2e"

echo "All E2E tests passed!"
```

## Deployment

### Build

```bash
# Single platform
go build -o swarm ./cmd/swarm

# Multi-platform
GOOS=darwin GOARCH=amd64 go build -o swarm-darwin-amd64
GOOS=darwin GOARCH=arm64 go build -o swarm-darwin-arm64
GOOS=linux GOARCH=amd64 go build -o swarm-linux-amd64
```

### Installation

```bash
# Via Makefile
make install  # Builds and copies to /usr/local/bin

# Manual
cp swarm /usr/local/bin/
chmod +x /usr/local/bin/swarm

# Shell completions
swarm completion bash > /etc/bash_completion.d/swarm
swarm completion zsh > /usr/local/share/zsh/site-functions/_swarm
```

## Monitoring & Observability

### Logging

```go
// Structured logging with zerolog
log.Info().
    Str("repo", repoName).
    Str("branch", branch).
    Str("path", path).
    Msg("created worktree")

log.Error().
    Err(err).
    Str("command", "git worktree add").
    Msg("failed to create worktree")
```

### Metrics (Future)

Potential metrics to track:
- Worktrees created/removed per day
- Average worktree lifetime
- Most common branch patterns
- Session attach latency
- State file size growth

## References

- [Git Worktree Documentation](https://git-scm.com/docs/git-worktree)
- [Tmux Manual](https://man.openbsd.org/tmux.1)
- [Bubble Tea Guide](https://github.com/charmbracelet/bubbletea)
- [Cobra CLI Framework](https://github.com/spf13/cobra)
