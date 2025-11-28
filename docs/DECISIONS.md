# Architecture Decision Records

## ADR-001: Technology Stack - Go + Bubble Tea

**Date:** 2025-11-10
**Status:** Accepted
**Context:** Need to choose implementation language and TUI framework

### Decision

Use **Go** with **Bubble Tea** for TUI and **Cobra** for CLI.

### Rationale

**Go Advantages:**
1. **Single binary distribution** - No runtime dependencies to install
2. **Fast startup** - Sub-100ms cold start achievable
3. **Cross-compilation** - Easy to build for macOS, Linux, Windows
4. **Strong stdlib** - exec, os, filepath well-suited for our needs
5. **Readability** - Code remains maintainable for future developers
6. **Mature tooling** - go fmt, go test, go mod built-in

**Bubble Tea Advantages:**
1. **Battle-tested** - Used in production CLIs (gh, glow, soft-serve)
2. **Elm Architecture** - Predictable, testable state management
3. **Component library** - Bubbles provides list, table, input, spinner, etc.
4. **Active maintenance** - Regular updates, responsive maintainers
5. **Documentation** - Extensive examples and tutorials

**Cobra Advantages:**
1. **Industry standard** - kubectl, hugo, gh all use it
2. **Command hierarchy** - Natural fit for our subcommand structure
3. **Auto help** - Generates --help output automatically
4. **Shell completion** - bash/zsh/fish support built-in

### Alternatives Considered

**Rust + ratatui:**
- **Pros**: Maximum performance, memory safety
- **Cons**: Slower development iteration, steeper learning curve for contributors, longer compile times
- **Verdict**: Over-optimization for this use case

**Python + Textual:**
- **Pros**: Fastest prototyping, rich ecosystem
- **Cons**: Startup overhead (100-200ms), distribution complexity (venv, dependencies), harder to package as single binary
- **Verdict**: Unsuitable for CLI tool that needs instant responsiveness

### Consequences

**Positive:**
- Fast, self-contained binary users can just download and run
- Good balance of development speed and runtime performance
- Rich ecosystem for CLI/TUI development
- Easy to onboard new contributors (Go is readable)

**Negative:**
- Learning curve if team is not familiar with Go
- Less "script-like" than Python for quick changes
- Must compile before testing (but compilation is fast)

### Review Trigger

Reconsider if:
- Startup performance becomes critical (<10ms requirement)
- Need for extensive async/concurrency patterns (though Go handles this well)
- Team expertise shifts significantly to Rust

---

## ADR-002: Worktree Directory Pattern A (Flat Sibling)

**Date:** 2025-11-10
**Status:** Accepted
**Context:** Need to decide where worktree directories live relative to base repo

### Decision

Use **Pattern A: Flat sibling cluster**
```
ai_working/
├── my-project/
├── my-project__wt__main/
├── my-project__wt__feature_foo/
```

### Rationale

**Advantages:**
1. **AI Tool Visibility** - All worktrees appear as first-class directories in `ai_working/`
2. **Simple Discovery** - Easy to glob: `ai_working/<repo>__wt__*`
3. **No Nesting** - Avoids `.git` traversal complexity
4. **Clean Separation** - Base repo remains untouched
5. **Easy Cleanup** - Can `rm -rf *__wt__*` safely

**Alignment with Requirements:**
- Spec requirement: "The AI tool indexes all subdirectories under ai_working"
- Pattern A ensures worktrees are indexed equally

### Alternatives Considered

**Pattern B: Subfolder**
```
ai_working/
├── my-project/
└── my-project.worktrees/
    ├── main/
    └── feature_foo/
```
- **Pros**: Cleaner namespace, grouped by repo
- **Cons**: Extra directory level, less discoverable, AI tool might ignore

**Pattern C: Nested under repo**
```
ai_working/
└── my-project/
    ├── .git/
    └── .swarm/worktrees/
        ├── main/
        └── feature_foo/
```
- **Pros**: All related files together
- **Cons**: Pollutes repo directory, `.git` confusion, harder to clean

### Consequences

**Positive:**
- Worktrees are always visible to AI context tools
- Simple mental model for users
- Easy to script/automate around

**Negative:**
- Directory listing of `ai_working/` becomes longer with many worktrees
- Naming collision potential (mitigated by `__wt__` infix)

### Configuration

Made configurable via `config.yml`:
```yaml
worktree_pattern: patternA  # or patternB, patternC
```

### Review Trigger

Reconsider if:
- AI tool indexing behavior changes
- Users consistently request different pattern
- Performance issues with flat directory structure

---

## ADR-003: State File as JSON (Not SQLite)

**Date:** 2025-11-10
**Status:** Accepted
**Context:** Need persistent storage for worktree metadata

### Decision

Use **JSON file** (`$REPOS_DIR/.swarm-state.json`) for state persistence.

### Rationale

**Advantages:**
1. **Human-readable** - Users can inspect/debug easily
2. **No dependencies** - JSON is stdlib
3. **Git-friendly** - Text file can be versioned if desired
4. **Simple backup** - Just copy the file
5. **Atomic writes** - write to temp + rename is atomic on POSIX
6. **Fast for small datasets** - <100 repos, <1000 worktrees typical

**File Locking:**
Use `gofrs/flock` for exclusive access during writes:
```go
lock := flock.New(lockFile)
lock.Lock()
defer lock.Unlock()
```

### Alternatives Considered

**SQLite:**
- **Pros**: Query capability, transactions, concurrent readers
- **Cons**: Binary format, dependency, overkill for simple key-value needs
- **Verdict**: Over-engineering for this scale

**BoltDB / BadgerDB:**
- **Pros**: Pure Go, embedded
- **Cons**: Still binary, more complex than needed
- **Verdict**: Unnecessary complexity

### Consequences

**Positive:**
- Simple implementation
- Easy to debug
- No schema migrations needed
- Works everywhere Go works

**Negative:**
- Entire file loaded into memory (fine for <1MB)
- No concurrent readers during writes (rare contention)
- Manual reconciliation with git reality required

### Performance Considerations

- Typical state file: ~10KB (10 repos × 5 worktrees × 200 bytes)
- Load time: <1ms
- Write time: <5ms
- Lock contention: Rare (most ops are reads or single-process)

### Review Trigger

Reconsider if:
- State file grows beyond 10MB
- Need for complex queries emerges
- Concurrent access becomes a bottleneck

---

## ADR-004: Git as Source of Truth (State is Cache)

**Date:** 2025-11-10
**Status:** Accepted
**Context:** State file could diverge from actual git worktree state

### Decision

**Git is authoritative.** State file is a cache for performance/convenience.

### Reconciliation Strategy

On every operation:
1. **Query git**: `git worktree list --porcelain`
2. **Load state**: Read `.swarm-state.json`
3. **Reconcile**:
   - Git has worktree, state doesn't → Add to state
   - State has worktree, git doesn't → Mark orphaned
   - Both have it → Update last_opened if needed
4. **Update state**: Write back atomically

### Rationale

**Advantages:**
1. **Robustness** - Manual git operations don't break swarm
2. **Recovery** - Corrupted state can be regenerated
3. **Simplicity** - Don't need to intercept all git operations
4. **Correctness** - git worktree list is always correct

**Implementation:**
```go
func Reconcile(repoPath string) ([]Worktree, error) {
    // Source of truth
    gitWorktrees := git.WorktreeList(repoPath)

    // Cached metadata
    stateWorktrees := state.LoadWorktrees(repoPath)

    // Merge
    reconciled := merge(gitWorktrees, stateWorktrees)

    // Save updated state
    state.SaveWorktrees(repoPath, reconciled)

    return reconciled, nil
}
```

### Consequences

**Positive:**
- External git operations don't break swarm
- State corruption is recoverable
- Simpler code (no need to hook into git)

**Negative:**
- Slight performance cost (always query git first)
- Orphan detection only happens during reconcile

### Review Trigger

Reconsider if:
- Performance of git worktree list becomes problematic
- Need real-time state without git query

---

## ADR-005: Tmux Session Lifecycle

**Date:** 2025-11-10
**Status:** Accepted
**Context:** How to manage tmux sessions for worktrees

### Decision

**Lazy session creation:** Sessions created on-demand, not automatically.

### Session Naming

Format: `<repo-slug>--wt--<worktree-slug>`
Example: `my-project--wt--feature_payments-refactor`

**Rationale:**
- Unique per worktree
- Human-readable
- Parseable (can extract repo and branch)
- Safe for tmux (alphanumeric + separators)

### Session Lifecycle

**Create:**
```go
func Create(name, path string, layout *Layout) error {
    cmd := exec.Command("tmux", "new-session", "-d",
        "-s", name,
        "-c", path)
    err := cmd.Run()

    // Apply layout if provided
    if layout != nil {
        applyLayout(name, layout)
    }

    return err
}
```

**Attach:**
```go
func Attach(name string) error {
    // Inside tmux: switch-client
    if os.Getenv("TMUX") != "" {
        return exec.Command("tmux", "switch-client", "-t", name).Run()
    }

    // Outside tmux: attach
    return syscall.Exec("/usr/bin/tmux", []string{"tmux", "attach", "-t", name}, os.Environ())
}
```

**Kill:**
```go
func Kill(name string) error {
    // Ignore error if session doesn't exist
    exec.Command("tmux", "kill-session", "-t", name).Run()
    return nil
}
```

### Consequences

**Positive:**
- Users control when sessions are created
- No zombie sessions for unused worktrees
- Clean separation: worktree ≠ session (though usually 1:1)

**Negative:**
- Must explicitly open to create session
- Session state not persisted (by design)

### Default Layout

```bash
tmux new-session -d -s "$name" -c "$path" "nvim ."
tmux new-window -t "$name":2 -c "$path"  # git/shell
tmux new-window -t "$name":3 -c "$path"  # tests
tmux select-window -t "$name":1
```

Users can override via config:
```yaml
tmux_layout_script: ~/.config/swarm/tmux-layout.sh
```

### Review Trigger

Reconsider if:
- Users want automatic session creation
- Session persistence becomes important
- Layout customization needs expand significantly

---

## ADR-006: Safety Checks Before Removal

**Date:** 2025-11-10
**Status:** Accepted
**Context:** Removing worktrees with uncommitted work is dangerous

### Decision

**Always check safety** before removal, require `--force` to override.

### Safety Checks

1. **Uncommitted changes:**
   ```bash
   git -C "$path" status --porcelain
   ```
   Non-empty output → unsafe

2. **Unpushed commits:**
   ```bash
   git -C "$path" log --oneline origin/$branch..HEAD
   ```
   Non-empty output → warning

3. **Branch merged:** (optional, Phase 2)
   ```bash
   git -C "$repo" branch --contains "$branch" | grep main
   ```
   Not merged → warning

### Implementation

```go
type SafetyResult struct {
    Safe     bool
    Warnings []string
    Blockers []string
}

func CheckRemovalSafety(wt *Worktree, opts RemoveOptions) (*SafetyResult, error) {
    result := &SafetyResult{Safe: true}

    // Check uncommitted
    if hasUncommitted(wt.Path) {
        result.Safe = false
        result.Blockers = append(result.Blockers,
            "Worktree has uncommitted changes")
    }

    // Check unpushed
    if hasUnpushed(wt.Path, wt.Branch) {
        result.Warnings = append(result.Warnings,
            "Branch has unpushed commits")
    }

    return result, nil
}
```

### User Experience

```bash
$ swarm remove my-project feature/foo

⚠️  Cannot remove worktree:
  • Worktree has uncommitted changes

View changes: cd /path/to/worktree && git status
Remove anyway: swarm remove my-project feature/foo --force

$ swarm remove my-project feature/foo --force
✓ Removed worktree my-project__wt__feature_foo
✓ Killed tmux session my-project--wt--feature_foo
```

### Consequences

**Positive:**
- Prevents accidental data loss
- Encourages good git hygiene
- Clear feedback on why removal is blocked

**Negative:**
- Extra git commands slow down removal slightly
- Users must use --force for legitimate cases

### Configuration

```yaml
# Skip safety checks by default (not recommended)
skip_safety_checks: false

# Auto-prune git after removal
auto_prune_on_remove: true
```

### Review Trigger

Reconsider if:
- Users find safety checks too restrictive
- Performance of checks becomes problematic
- More sophisticated merge detection needed

---

## ADR-007: Slug Collision Handling

**Date:** 2025-11-10
**Status:** Accepted
**Context:** Branch names might map to same slug

### Decision

**Append numeric suffix** on collision, preserve mapping in state.

### Algorithm

```go
func GenerateSlug(branch string, existing map[string]string) string {
    // Base slug: feature/foo → feature_foo
    base := sanitize(branch)

    // Check collision
    slug := base
    suffix := 2
    for existingBranch, ok := existing[slug]; ok {
        if existingBranch == branch {
            return slug  // Same branch, reuse slug
        }
        slug = fmt.Sprintf("%s_%d", base, suffix)
        suffix++
    }

    return slug
}

func sanitize(branch string) string {
    // Replace / with _
    slug := strings.ReplaceAll(branch, "/", "_")

    // Remove unsafe chars
    slug = regexp.MustCompile(`[^a-zA-Z0-9_-]`).ReplaceAllString(slug, "_")

    // Collapse multiple underscores
    slug = regexp.MustCompile(`_+`).ReplaceAllString(slug, "_")

    return strings.Trim(slug, "_")
}
```

### Examples

```
feature/foo        → feature_foo
feature/foo-v2     → feature_foo-v2
feature/foo (2nd)  → feature_foo_2  # Collision with existing
feat/foo           → feat_foo        # Different prefix, no collision
```

### State Mapping

```json
{
  "worktrees": {
    "feature_foo": {
      "slug": "feature_foo",
      "branch": "feature/foo",
      ...
    },
    "feature_foo_2": {
      "slug": "feature_foo_2",
      "branch": "feature/foo-v2",  // Different branch, same base slug
      ...
    }
  }
}
```

### Consequences

**Positive:**
- Deterministic slug generation
- Handles edge cases gracefully
- Preserves slug → branch mapping

**Negative:**
- Slugs might not exactly match branch name
- Must check state for collisions

### Review Trigger

Reconsider if:
- Users find numeric suffixes confusing
- Need more sophisticated disambiguation

---

## ADR-008: Minimal External Dependencies

**Date:** 2025-11-10
**Status:** Accepted
**Context:** Go projects can accumulate many dependencies

### Decision

**Minimize dependencies,** prefer stdlib where reasonable.

### Allowed Dependencies

**TUI:**
- `github.com/charmbracelet/bubbletea` - TUI framework (core requirement)
- `github.com/charmbracelet/bubbles` - UI components
- `github.com/charmbracelet/lipgloss` - Styling

**CLI:**
- `github.com/spf13/cobra` - Command framework (industry standard)
- `github.com/spf13/viper` - Configuration (integrates with cobra)

**Utilities:**
- `github.com/gofrs/flock` - File locking (no stdlib alternative)

**Testing:**
- `github.com/stretchr/testify` - Test assertions

### Rationale

**Prefer stdlib:**
- `encoding/json` for state (not external JSON library)
- `os/exec` for process execution (not external process lib)
- `flag` for simple parsing (cobra for complex)
- `log/slog` for logging (not zerolog/logrus unless needed)

**Benefits:**
- Smaller binary size
- Fewer supply chain risks
- Faster compilation
- More maintainable (less to update)

### Consequences

**Positive:**
- Lightweight, fast builds
- Easier security audits
- Less breaking changes from deps

**Negative:**
- Slightly more manual code
- Missing convenience functions from external libs

### Review Trigger

Reconsider if:
- Stdlib limitations become painful
- Specific library provides significant value

---

## Summary

These decisions reflect:
1. **Simplicity** - Choose boring technology (Go, JSON, flat directories)
2. **Robustness** - Git as source of truth, safety checks, reconciliation
3. **User Experience** - Clear errors, predictable behavior, escape hatches (--force)
4. **Maintainability** - Minimal deps, readable code, good documentation

All decisions are reviewable and can evolve based on real-world usage.
