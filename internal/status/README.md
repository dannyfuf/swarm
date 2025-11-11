# Status Package

Efficient worktree status computation with TTL-based caching and parallel processing.

## Overview

The status package provides functionality to compute and cache worktree status information, including:
- Uncommitted changes detection
- Unpushed commits detection
- Branch merge status
- Orphaned worktree detection
- Visual badge indicators for UI display

## Key Features

- **TTL-based caching**: Reduces redundant git operations
- **Parallel computation**: Worker pool pattern for computing multiple worktree statuses
- **Thread-safe**: Uses sync.RWMutex for concurrent access
- **Cache invalidation**: Methods to clear specific or all cached data
- **Visual badges**: Pre-defined badges for UI status display

## Usage

### Basic Status Computation

```go
import (
    "time"
    "github.com/microsoft/amplifier/swarm/internal/status"
    "github.com/microsoft/amplifier/swarm/internal/git"
    "github.com/microsoft/amplifier/swarm/internal/worktree"
)

// Create a status computer with 5-minute cache TTL
computer := status.NewComputer(5 * time.Minute)

// Compute status for a worktree
gitClient := git.NewClient()
wt := &worktree.Worktree{
    Path:   "/path/to/worktree",
    Branch: "feature-branch",
}

opts := status.ComputeOptions{
    RepoPath:      "/path/to/repo",
    DefaultBranch: "main",
}

st, err := computer.Compute(gitClient, wt, opts)
if err != nil {
    log.Fatal(err)
}

fmt.Printf("Has changes: %v\n", st.HasChanges)
fmt.Printf("Has unpushed: %v\n", st.HasUnpushed)
```

### Parallel Computation

```go
// Prepare worktrees with options
items := []status.WorktreeWithOptions{
    {
        Worktree: wt1,
        Options: status.ComputeOptions{
            RepoPath:      "/repo",
            DefaultBranch: "main",
        },
    },
    {
        Worktree: wt2,
        Options: status.ComputeOptions{
            RepoPath:      "/repo",
            DefaultBranch: "main",
        },
    },
}

// Compute all in parallel (uses worker pool)
results := computer.ComputeAll(gitClient, items)

for path, status := range results {
    fmt.Printf("%s: %d badges\n", path, len(status.GetBadges()))
}
```

### Cache Management

```go
// Invalidate specific worktree cache
computer.InvalidateCache("/path/to/worktree")

// Clear all cached status
computer.ClearCache()
```

### Visual Badges

```go
st, _ := computer.Compute(gitClient, wt, opts)

// Get badge indicators for UI
badges := st.GetBadges()
for _, badge := range badges {
    fmt.Printf("%s (%s): %s\n", badge.Symbol, badge.Color, badge.Hint)
}
```

## Status Fields

### Status

```go
type Status struct {
    HasChanges   bool   // Uncommitted changes present
    HasUnpushed  bool   // Unpushed commits present
    BranchMerged *bool  // nil = unknown, true = merged, false = not merged
    IsOrphaned   bool   // Worktree no longer tracked
}
```

### Badge

```go
type Badge struct {
    Symbol string  // Visual symbol (●, ↑, ✓, ⚠)
    Color  string  // Color name (yellow, cyan, green, red)
    Hint   string  // Description text
}
```

## Badge Indicators

| Symbol | Color  | Meaning               |
|--------|--------|-----------------------|
| ●      | yellow | uncommitted changes   |
| ↑      | cyan   | unpushed commits      |
| ✓      | green  | merged                |
| ⚠      | red    | orphaned              |

## Performance Considerations

### Caching Strategy

- **Short TTL (1-5 min)**: Quick status checks, skips expensive merge detection
- **Long TTL (>5 min)**: Includes merge status computation
- Cache is checked before every computation to avoid redundant git operations

### Parallel Processing

The `ComputeAll` method uses a worker pool pattern:
- Workers limited to `min(runtime.NumCPU(), 4)`
- Prevents overwhelming git with concurrent operations
- Thread-safe result collection

### Cache Invalidation

Invalidate cache when:
- Creating new commits
- Pushing to remote
- Creating/deleting branches
- Any mutation that changes worktree state

## Thread Safety

All public methods are thread-safe:
- Uses `sync.RWMutex` for cache access
- Read lock for cache checks
- Write lock for cache updates
- Safe for concurrent use from multiple goroutines

## Implementation Philosophy

Follows the project's implementation philosophy:
- **Ruthless simplicity**: Clear, minimal code
- **Direct integration**: No unnecessary abstractions
- **Proper error handling**: Returns errors, doesn't panic
- **Self-contained**: All logic within the package

## Testing

Run tests:
```bash
go test ./internal/status/... -v
```

Test coverage includes:
- Cache management (create, invalidate, clear)
- Badge generation with various status combinations
- Parallel computation worker pool
- TTL expiration behavior
