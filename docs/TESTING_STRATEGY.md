# Testing Strategy

## Overview

Swarm uses a comprehensive testing approach with three levels:
1. **Unit Tests** - Test individual functions/modules in isolation
2. **Integration Tests** - Test module interactions
3. **End-to-End Tests** - Test complete user workflows

**Target Coverage:** >80% for all modules

---

## Testing Principles

### 1. Test-First Development

Write tests **before or alongside** implementation:

```go
// 1. Write failing test
func TestGenerateSlug(t *testing.T) {
    got := GenerateSlug("feature/foo")
    assert.Equal(t, "feature_foo", got)
}

// 2. Implement to make it pass
func GenerateSlug(branch string) string {
    return strings.ReplaceAll(branch, "/", "_")
}

// 3. Refactor (tests still pass)
```

### 2. Arrange-Act-Assert Pattern

Structure tests clearly:

```go
func TestWorktreeCreate(t *testing.T) {
    // Arrange
    repo := &Repo{Name: "test", Path: "/tmp/test"}
    opts := CreateOptions{Branch: "feature/foo"}

    // Act
    wt, err := manager.Create(repo, opts)

    // Assert
    require.NoError(t, err)
    assert.Equal(t, "feature_foo", wt.Slug)
    assert.DirExists(t, wt.Path)
}
```

### 3. Table-Driven Tests

Test multiple cases efficiently:

```go
func TestSlugGeneration(t *testing.T) {
    tests := []struct {
        name   string
        branch string
        want   string
    }{
        {"simple", "main", "main"},
        {"with slash", "feature/foo", "feature_foo"},
        {"with special chars", "bug/fix-#123", "bug_fix-123"},
        {"long name", strings.Repeat("a", 100), strings.Repeat("a", 80)},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got := GenerateSlug(tt.branch)
            assert.Equal(t, tt.want, got)
        })
    }
}
```

### 4. Dependency Injection

Make modules testable:

```go
// Good: Inject dependencies
type Manager struct {
    git   GitClient
    state StateStore
}

func (m *Manager) Create(repo *Repo, opts CreateOptions) (*Worktree, error) {
    // Uses injected git client (can be mocked)
    return m.git.WorktreeAdd(repo.Path, opts)
}

// In tests: inject mock
mockGit := &MockGitClient{}
manager := &Manager{git: mockGit}
```

### 5. Clean Up After Tests

```go
func TestWithTempDir(t *testing.T) {
    // Use t.TempDir() for automatic cleanup
    tmpDir := t.TempDir()

    // Test code...
    // Cleanup happens automatically
}

func TestWithManualCleanup(t *testing.T) {
    resource := acquireResource()
    defer resource.Release() // Ensure cleanup

    // Test code...
}
```

---

## Unit Tests

**Goal:** Test individual functions in isolation

**Location:** `_test.go` files next to implementation

**Run:** `go test ./internal/modulename/`

### Module-Specific Tests

#### 1. Config Module

```go
// internal/config/loader_test.go
func TestLoaderDefaults(t *testing.T) {
    loader := NewLoader()
    cfg, err := loader.Load()

    require.NoError(t, err)
    assert.Equal(t, "main", cfg.DefaultBaseBranch)
    assert.Equal(t, "patternA", cfg.WorktreePattern)
}

func TestLoaderEnvOverride(t *testing.T) {
    os.Setenv("SWARM_DEFAULT_BASE_BRANCH", "develop")
    defer os.Unsetenv("SWARM_DEFAULT_BASE_BRANCH")

    loader := NewLoader()
    cfg, err := loader.Load()

    require.NoError(t, err)
    assert.Equal(t, "develop", cfg.DefaultBaseBranch)
}

func TestValidateInvalidDir(t *testing.T) {
    cfg := &Config{ReposDir: "/nonexistent"}
    err := cfg.Validate()

    assert.Error(t, err)
    assert.Contains(t, err.Error(), "does not exist")
}
```

#### 2. Git Module (Parser)

```go
// internal/git/parser_test.go
func TestParseWorktreeList(t *testing.T) {
    // Use fixture data
    output := `worktree /path/to/repo
HEAD abc123
branch refs/heads/main

worktree /path/to/repo__wt__feature_foo
HEAD def456
branch refs/heads/feature/foo
`

    parser := &Parser{}
    worktrees, err := parser.ParseWorktreeList(output)

    require.NoError(t, err)
    assert.Len(t, worktrees, 2)
    assert.Equal(t, "main", worktrees[0].Branch)
    assert.Equal(t, "feature/foo", worktrees[1].Branch)
}

func TestParseStatus(t *testing.T) {
    output := ` M file1.txt
A  file2.txt
?? untracked.txt
`

    parser := &Parser{}
    status, err := parser.ParseStatus(output)

    require.NoError(t, err)
    assert.Contains(t, status.Modified, "file1.txt")
    assert.Contains(t, status.Added, "file2.txt")
    assert.Contains(t, status.Untracked, "untracked.txt")
}
```

#### 3. State Module

```go
// internal/state/store_test.go
func TestStoreSaveLoad(t *testing.T) {
    tmpDir := t.TempDir()
    store := NewStore(tmpDir)

    // Create state
    state := &State{
        Version: 1,
        Repos: map[string]*RepoState{
            "test": {
                Path: "/path/to/test",
                Worktrees: map[string]*WorktreeState{
                    "feature_foo": {
                        Slug: "feature_foo",
                        Branch: "feature/foo",
                    },
                },
            },
        },
    }

    // Save
    err := store.Save(state)
    require.NoError(t, err)

    // Load
    loaded, err := store.Load()
    require.NoError(t, err)
    assert.Equal(t, state.Repos["test"].Path, loaded.Repos["test"].Path)
}

func TestStoreAtomicWrite(t *testing.T) {
    tmpDir := t.TempDir()
    store := NewStore(tmpDir)

    state := &State{Version: 1, Repos: make(map[string]*RepoState)}

    // Multiple concurrent saves
    var wg sync.WaitGroup
    for i := 0; i < 10; i++ {
        wg.Add(1)
        go func(n int) {
            defer wg.Done()
            state.Repos[fmt.Sprintf("repo%d", n)] = &RepoState{}
            store.Save(state)
        }(i)
    }
    wg.Wait()

    // Verify state is consistent (not corrupted)
    loaded, err := store.Load()
    require.NoError(t, err)
    assert.NotNil(t, loaded)
}
```

#### 4. Worktree Module (Slug)

```go
// internal/worktree/slug_test.go
func TestGenerateSlug(t *testing.T) {
    tests := []struct {
        name   string
        branch string
        want   string
    }{
        {"simple", "main", "main"},
        {"with slash", "feature/foo", "feature_foo"},
        {"multiple slashes", "feature/sub/bar", "feature_sub_bar"},
        {"special chars", "bug/fix-#123", "bug_fix-123"},
        {"long name", strings.Repeat("a", 100), strings.Repeat("a", 80)},
        {"leading slash", "/feature/foo", "feature_foo"},
        {"trailing slash", "feature/foo/", "feature_foo"},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got := GenerateSlug(tt.branch)
            assert.Equal(t, tt.want, got)
        })
    }
}

func TestGenerateUniqueSlug(t *testing.T) {
    existing := map[string]string{
        "feature_foo":   "feature/foo",
        "feature_foo_2": "feature/foo-v2",
    }

    tests := []struct {
        name   string
        branch string
        want   string
    }{
        {"no collision", "feature/bar", "feature_bar"},
        {"reuse same branch", "feature/foo", "feature_foo"},
        {"collision different branch", "feature/foo-v3", "feature_foo_3"},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got := GenerateUniqueSlug(tt.branch, existing)
            assert.Equal(t, tt.want, got)
        })
    }
}
```

---

## Integration Tests

**Goal:** Test module interactions with real dependencies

**Location:** `_test.go` files with `// +build integration` tag

**Run:** `go test -tags=integration ./...`

### Git Integration Tests

```go
// +build integration

// internal/git/client_integration_test.go
package git

import (
    "os"
    "os/exec"
    "path/filepath"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func setupTestRepo(t *testing.T) string {
    tmpDir := t.TempDir()
    repoPath := filepath.Join(tmpDir, "test-repo")

    // Initialize repo
    exec.Command("git", "init", repoPath).Run()
    exec.Command("git", "-C", repoPath, "config", "user.name", "Test").Run()
    exec.Command("git", "-C", repoPath, "config", "user.email", "test@test.com").Run()

    // Initial commit
    os.WriteFile(filepath.Join(repoPath, "README.md"), []byte("# Test"), 0644)
    exec.Command("git", "-C", repoPath, "add", ".").Run()
    exec.Command("git", "-C", repoPath, "commit", "-m", "Initial").Run()

    return repoPath
}

func TestWorktreeLifecycle(t *testing.T) {
    repoPath := setupTestRepo(t)
    client := NewClient()

    // Create worktree
    wtPath := filepath.Join(filepath.Dir(repoPath), "test-repo__wt__feature_test")
    err := client.WorktreeAdd(repoPath, AddOptions{
        Path:      wtPath,
        Branch:    "feature/test",
        NewBranch: true,
    })
    require.NoError(t, err)
    assert.DirExists(t, wtPath)

    // List worktrees
    worktrees, err := client.WorktreeList(repoPath)
    require.NoError(t, err)
    assert.Len(t, worktrees, 2) // main + feature/test

    var found bool
    for _, wt := range worktrees {
        if wt.Branch == "feature/test" {
            found = true
            assert.Equal(t, wtPath, wt.Path)
        }
    }
    assert.True(t, found, "Created worktree not found in list")

    // Remove worktree
    err = client.WorktreeRemove(repoPath, wtPath)
    require.NoError(t, err)

    // Verify removed
    _, err = os.Stat(wtPath)
    assert.True(t, os.IsNotExist(err))
}

func TestWorktreeStatusChecks(t *testing.T) {
    repoPath := setupTestRepo(t)
    client := NewClient()

    // Create worktree
    wtPath := filepath.Join(filepath.Dir(repoPath), "test-repo__wt__dirty")
    client.WorktreeAdd(repoPath, AddOptions{
        Path:      wtPath,
        Branch:    "dirty",
        NewBranch: true,
    })

    // Make changes
    testFile := filepath.Join(wtPath, "test.txt")
    os.WriteFile(testFile, []byte("changes"), 0644)

    // Check status
    status, err := client.Status(wtPath)
    require.NoError(t, err)
    assert.Contains(t, status.Untracked, "test.txt")
}
```

### Repo + Worktree Integration

```go
// +build integration

func TestRepoDiscoveryWithWorktrees(t *testing.T) {
    tmpDir := t.TempDir()

    // Create repos
    setupTestRepo(t, filepath.Join(tmpDir, "repo1"))
    setupTestRepo(t, filepath.Join(tmpDir, "repo2"))

    cfg := &config.Config{ReposDir: tmpDir}
    discovery := repo.NewDiscovery(cfg, git.NewClient())
    manager := worktree.NewManager(cfg, git.NewClient(), state.NewStore(tmpDir))

    // Scan repos
    repos, err := discovery.ScanAll()
    require.NoError(t, err)
    assert.Len(t, repos, 2)

    // Create worktree
    wt, err := manager.Create(&repos[0], worktree.CreateOptions{
        Branch:     "feature/test",
        BaseBranch: "main",
    })
    require.NoError(t, err)

    // Verify worktree directory exists
    assert.DirExists(t, wt.Path)

    // Scan again - should skip worktree directory
    repos2, err := discovery.ScanAll()
    require.NoError(t, err)
    assert.Len(t, repos2, 2) // Still only 2 repos (worktree dir excluded)
}
```

---

## End-to-End Tests

**Goal:** Test complete user workflows via CLI

**Location:** `test/e2e/`

**Run:** `./test/e2e/run_tests.sh`

### Shell Script Tests

```bash
#!/usr/bin/env bash
# test/e2e/worktree_lifecycle_test.sh

set -euo pipefail

# Setup
WORK_DIR=$(mktemp -d)
export REPOS_DIR="$WORK_DIR"
trap "rm -rf $WORK_DIR" EXIT

# Initialize test repo
git init "$WORK_DIR/test-repo"
cd "$WORK_DIR/test-repo"
git config user.name "Test"
git config user.email "test@test.com"
touch README.md
git add .
git commit -m "Initial commit"

# Build swarm
cd ~/amplifier/ai_working/swarm
go build -o /tmp/swarm ./cmd/swarm
SWARM="/tmp/swarm"

# Test: Create worktree
echo "Testing: swarm create"
$SWARM create test-repo feature/test --from main
assert_dir_exists "$WORK_DIR/test-repo__wt__feature_test"

# Test: List worktrees
echo "Testing: swarm list"
output=$($SWARM list test-repo)
assert_contains "$output" "feature_test"
assert_contains "$output" "feature/test"

# Test: Open worktree (create session)
echo "Testing: swarm open"
$SWARM open test-repo feature/test --create
assert_tmux_session_exists "test-repo--wt--feature_test"

# Test: Remove worktree
echo "Testing: swarm remove"
$SWARM remove test-repo feature/test --force
assert_dir_not_exists "$WORK_DIR/test-repo__wt__feature_test"
assert_tmux_session_not_exists "test-repo--wt--feature_test"

echo "All E2E tests passed!"

# Helper functions
assert_dir_exists() {
    [ -d "$1" ] || { echo "FAIL: Directory $1 does not exist"; exit 1; }
}

assert_dir_not_exists() {
    [ ! -d "$1" ] || { echo "FAIL: Directory $1 still exists"; exit 1; }
}

assert_contains() {
    echo "$1" | grep -q "$2" || { echo "FAIL: '$1' does not contain '$2'"; exit 1; }
}

assert_tmux_session_exists() {
    tmux has-session -t "$1" 2>/dev/null || { echo "FAIL: Tmux session $1 does not exist"; exit 1; }
}

assert_tmux_session_not_exists() {
    ! tmux has-session -t "$1" 2>/dev/null || { echo "FAIL: Tmux session $1 still exists"; exit 1; }
}
```

### Go-based E2E Tests

```go
// test/e2e/cli_test.go
// +build e2e

package e2e

import (
    "os"
    "os/exec"
    "path/filepath"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestCLIWorkflow(t *testing.T) {
    // Setup
    tmpDir := t.TempDir()
    os.Setenv("REPOS_DIR", tmpDir)
    defer os.Unsetenv("REPOS_DIR")

    // Create test repo
    repoPath := filepath.Join(tmpDir, "test-repo")
    setupGitRepo(repoPath)

    // Build swarm binary
    swarmBin := filepath.Join(tmpDir, "swarm")
    buildCmd := exec.Command("go", "build", "-o", swarmBin, "./cmd/swarm")
    require.NoError(t, buildCmd.Run())

    // Test: create
    createCmd := exec.Command(swarmBin, "create", "test-repo", "feature/e2e", "--from", "main")
    output, err := createCmd.CombinedOutput()
    require.NoError(t, err, "create failed: %s", output)

    wtPath := filepath.Join(tmpDir, "test-repo__wt__feature_e2e")
    assert.DirExists(t, wtPath)

    // Test: list
    listCmd := exec.Command(swarmBin, "list", "test-repo")
    output, err = listCmd.CombinedOutput()
    require.NoError(t, err)
    assert.Contains(t, string(output), "feature_e2e")

    // Test: remove
    removeCmd := exec.Command(swarmBin, "remove", "test-repo", "feature/e2e", "--force")
    output, err = removeCmd.CombinedOutput()
    require.NoError(t, err)

    _, err = os.Stat(wtPath)
    assert.True(t, os.IsNotExist(err))
}
```

---

## Test Organization

### Directory Structure

```
swarm/
├── internal/
│   ├── config/
│   │   ├── config.go
│   │   └── config_test.go         # Unit tests
│   ├── git/
│   │   ├── client.go
│   │   ├── parser.go
│   │   ├── parser_test.go         # Unit (parser)
│   │   └── client_integration_test.go  # Integration
│   └── worktree/
│       ├── manager.go
│       ├── slug.go
│       ├── manager_test.go        # Unit
│       ├── slug_test.go           # Unit
│       └── manager_integration_test.go  # Integration
└── test/
    ├── fixtures/                  # Test data
    │   ├── git_worktree_list.txt
    │   └── git_status.txt
    ├── integration/               # Cross-module integration
    │   └── repo_worktree_test.go
    └── e2e/                       # End-to-end
        ├── cli_test.go
        └── worktree_lifecycle.sh
```

### Test Naming Conventions

```
TestFunctionName                    # Unit test
TestFunctionName_EdgeCase           # Specific edge case
TestFunctionNameIntegration         # Integration test
TestFunctionNameE2E                 # End-to-end test
```

### Build Tags

```go
// +build integration
// Run with: go test -tags=integration

// +build e2e
// Run with: go test -tags=e2e
```

---

## Running Tests

### Quick Test (Unit Only)

```bash
# All packages
go test ./...

# Specific package
go test ./internal/worktree/

# With coverage
go test ./... -coverprofile=coverage.out
go tool cover -html=coverage.out

# Verbose
go test ./... -v

# Specific test
go test ./internal/worktree -run TestGenerateSlug
```

### Integration Tests

```bash
# All integration tests
go test -tags=integration ./...

# Specific module
go test -tags=integration ./internal/git/

# With setup
export REPOS_DIR="/tmp/swarm-test"
go test -tags=integration ./...
```

### End-to-End Tests

```bash
# Shell scripts
./test/e2e/run_all.sh

# Go-based
go test -tags=e2e ./test/e2e/

# Individual script
./test/e2e/worktree_lifecycle_test.sh
```

### All Tests (CI Pipeline)

```bash
# Full test suite
make test

# Or manually:
go test ./...                           # Unit
go test -tags=integration ./...         # Integration
go test -tags=e2e ./test/e2e/          # E2E
./test/e2e/run_all.sh                  # Shell E2E
```

---

## Test Helpers and Fixtures

### Common Test Utilities

```go
// test/testutil/git.go
package testutil

import (
    "os"
    "os/exec"
    "path/filepath"
    "testing"
)

func SetupGitRepo(t *testing.T, path string) {
    os.MkdirAll(path, 0755)

    exec.Command("git", "init", path).Run()
    exec.Command("git", "-C", path, "config", "user.name", "Test").Run()
    exec.Command("git", "-C", path, "config", "user.email", "test@test.com").Run()

    readme := filepath.Join(path, "README.md")
    os.WriteFile(readme, []byte("# Test"), 0644)
    exec.Command("git", "-C", path, "add", ".").Run()
    exec.Command("git", "-C", path, "commit", "-m", "Initial commit").Run()
}

func SetupWorkspace(t *testing.T) string {
    tmpDir := t.TempDir()
    SetupGitRepo(t, filepath.Join(tmpDir, "repo1"))
    SetupGitRepo(t, filepath.Join(tmpDir, "repo2"))
    return tmpDir
}
```

### Fixtures

```
test/fixtures/
├── git_worktree_list.txt          # Sample git output
├── git_status_clean.txt
├── git_status_dirty.txt
└── swarm_state.json               # Sample state file
```

**Load fixtures in tests:**
```go
func TestParseWorktreeList(t *testing.T) {
    data, _ := os.ReadFile("../../test/fixtures/git_worktree_list.txt")
    worktrees, err := parser.ParseWorktreeList(string(data))

    require.NoError(t, err)
    assert.Len(t, worktrees, 2)
}
```

---

## Coverage Goals

### Per-Module Targets

- **Config:** 85%+ (high value, simple logic)
- **Git:** 80%+ (parser 90%, client 70%)
- **State:** 85%+ (critical for data integrity)
- **Repo:** 75%+ (mostly filesystem operations)
- **Worktree:** 85%+ (core business logic)
- **Tmux:** 70%+ (harder to test, more integration-focused)
- **Safety:** 90%+ (critical for preventing data loss)

### Measuring Coverage

```bash
# Generate coverage report
go test ./... -coverprofile=coverage.out

# View in terminal
go tool cover -func=coverage.out

# View in browser
go tool cover -html=coverage.out

# Per-package coverage
go test ./internal/config/ -coverprofile=config_coverage.out
go tool cover -func=config_coverage.out
```

### Coverage Report Example

```
github.com/microsoft/amplifier/swarm/internal/config/config.go:15:    Load        100.0%
github.com/microsoft/amplifier/swarm/internal/config/validate.go:10: Validate    90.0%
github.com/microsoft/amplifier/swarm/internal/git/parser.go:20:      ParseWorktreeList   95.0%
github.com/microsoft/amplifier/swarm/internal/worktree/slug.go:15:   GenerateSlug        100.0%
```

---

## Continuous Integration

### GitHub Actions Workflow

```yaml
# .github/workflows/test.yml
name: Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Set up Go
        uses: actions/setup-go@v4
        with:
          go-version: '1.21'

      - name: Install dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y git tmux

      - name: Run unit tests
        run: go test ./... -v

      - name: Run integration tests
        run: go test -tags=integration ./... -v

      - name: Generate coverage
        run: go test ./... -coverprofile=coverage.out

      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage.out
```

---

## Summary

**Test Pyramid:**
```
        /\
       /E2E\         10%  - Shell scripts, full workflows
      /------\
     /Integra \      30%  - Real git/tmux, module interactions
    /----------\
   /   Unit     \    60%  - Functions, logic, edge cases
  /--------------\
```

**Key Practices:**
1. Write tests first or alongside code
2. Use table-driven tests for multiple cases
3. Inject dependencies for testability
4. Tag integration tests appropriately
5. Maintain >80% coverage
6. Run tests frequently during development

**Commands to Remember:**
```bash
go test ./...                          # Quick unit tests
go test -tags=integration ./...        # Integration tests
go test ./... -coverprofile=coverage.out  # With coverage
go test -v -run TestSpecificTest       # Single test
make test                              # All tests (CI)
```

---

**Next:** Start implementing modules with tests from [PHASE-1-FOUNDATION.md](plans/PHASE-1-FOUNDATION.md)
