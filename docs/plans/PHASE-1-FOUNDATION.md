# Phase 1: Foundation & Core CLI

**Goal:** Build foundational modules and basic CLI commands for worktree lifecycle management.

**Duration Estimate:** 2-3 weeks for junior developer

**Deliverables:**
- Project scaffolding with Go modules
- Config, Git, State, Repo modules
- Basic CLI: `create`, `list`, `open`, `remove`
- Working worktree lifecycle (create → open → remove)
- Unit and integration tests

---

## Prerequisites

### Required Tools
```bash
# Install Go (1.21+)
brew install go  # macOS
# or download from https://go.dev/dl/

# Install tmux
brew install tmux  # macOS

# Verify installations
go version      # Should be 1.21 or higher
tmux -V         # Should be 3.0 or higher
git --version   # Should be 2.31 or higher
```

### Environment Setup
```bash
# Navigate to project
cd ~/amplifier/ai_working/swarm

# Initialize Go module
go mod init github.com/microsoft/amplifier/swarm

# Set AI_WORKING_DIR for testing
export AI_WORKING_DIR="$HOME/amplifier/ai_working"
```

---

## Task Breakdown

### Task 1.1: Project Scaffolding (2-3 hours)

**Objective:** Set up Go project structure following MODULES.md

**Steps:**

1. **Create directory structure:**
```bash
mkdir -p cmd/swarm
mkdir -p internal/{config,git,state,repo,worktree,tmux,safety}
mkdir -p pkg/types
mkdir -p test/{fixtures,integration}
mkdir -p docs/plans
```

2. **Initialize go.mod with dependencies:**
```bash
go get github.com/spf13/cobra@latest
go get github.com/spf13/viper@latest
go get github.com/gofrs/flock@latest

# Testing dependencies
go get github.com/stretchr/testify@latest
```

3. **Create basic main.go:**
```go
// cmd/swarm/main.go
package main

import (
    "fmt"
    "os"
    "github.com/microsoft/amplifier/swarm/cmd"
)

func main() {
    if err := cmd.Execute(); err != nil {
        fmt.Fprintf(os.Stderr, "Error: %v\n", err)
        os.Exit(1)
    }
}
```

4. **Create root command:**
```go
// cmd/root.go
package cmd

import (
    "github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
    Use:   "swarm",
    Short: "Git worktree + tmux session manager",
    Long: `Swarm manages Git worktrees with dedicated tmux sessions
for parallel development workflows.`,
}

func Execute() error {
    return rootCmd.Execute()
}

func init() {
    // Global flags
    rootCmd.PersistentFlags().String("ai-working-dir", "",
        "Override AI_WORKING_DIR location")
    rootCmd.PersistentFlags().Bool("dry-run", false,
        "Show what would be done without doing it")
}
```

5. **Test build:**
```bash
go build -o swarm ./cmd/swarm
./swarm --help
```

**Expected Output:**
```
Swarm manages Git worktrees with dedicated tmux sessions
for parallel development workflows.

Usage:
  swarm [command]

Available Commands:
  help        Help about any command

Flags:
      --ai-working-dir string   Override AI_WORKING_DIR location
      --dry-run                 Show what would be done without doing it
  -h, --help                    help for swarm

Use "swarm [command] --help" for more information about a command.
```

**Validation:**
- [ ] Directory structure matches MODULES.md
- [ ] `go build` succeeds
- [ ] `swarm --help` shows usage
- [ ] `go.mod` and `go.sum` exist

---

### Task 1.2: Config Module (4-6 hours)

**Objective:** Implement configuration loading with precedence

**Reference:** See `MODULES.md` section 5 (config module contract)

**Steps:**

1. **Create config types:**
```go
// internal/config/config.go
package config

import (
    "os"
    "path/filepath"
    "time"

    "github.com/spf13/viper"
)

// Config represents merged configuration
type Config struct {
    AIWorkingDir          string
    DefaultBaseBranch     string
    WorktreePattern       string
    CreateSessionOnCreate bool
    TmuxLayoutScript      string
    StatusCacheTTL        time.Duration
    PreferFzf             bool
    AutoPruneOnRemove     bool
}

// Defaults
var DefaultConfig = Config{
    AIWorkingDir:          "", // Will be set from env or home dir
    DefaultBaseBranch:     "main",
    WorktreePattern:       "patternA",
    CreateSessionOnCreate: true,
    TmuxLayoutScript:      "",
    StatusCacheTTL:        30 * time.Second,
    PreferFzf:             false,
    AutoPruneOnRemove:     true,
}
```

2. **Implement Loader:**
```go
// internal/config/loader.go
package config

import (
    "fmt"
    "os"
    "path/filepath"
)

type Loader struct {
    viper *viper.Viper
}

func NewLoader() *Loader {
    v := viper.New()

    // Set defaults
    v.SetDefault("ai_working_dir", getDefaultAIWorkingDir())
    v.SetDefault("default_base_branch", "main")
    v.SetDefault("worktree_pattern", "patternA")
    v.SetDefault("create_session_on_create", true)
    v.SetDefault("status_cache_ttl", "30s")
    v.SetDefault("auto_prune_on_remove", true)

    // Environment variables (with SWARM_ prefix)
    v.SetEnvPrefix("SWARM")
    v.AutomaticEnv()

    return &Loader{viper: v}
}

func (l *Loader) Load() (*Config, error) {
    // Try user config
    configHome := os.Getenv("XDG_CONFIG_HOME")
    if configHome == "" {
        home, _ := os.UserHomeDir()
        configHome = filepath.Join(home, ".config")
    }

    configPath := filepath.Join(configHome, "swarm")
    l.viper.AddConfigPath(configPath)
    l.viper.SetConfigName("config")
    l.viper.SetConfigType("yaml")

    // Read config (ignore error if file doesn't exist)
    _ = l.viper.ReadInConfig()

    // Build Config struct
    cfg := &Config{
        AIWorkingDir:          l.viper.GetString("ai_working_dir"),
        DefaultBaseBranch:     l.viper.GetString("default_base_branch"),
        WorktreePattern:       l.viper.GetString("worktree_pattern"),
        CreateSessionOnCreate: l.viper.GetBool("create_session_on_create"),
        TmuxLayoutScript:      l.viper.GetString("tmux_layout_script"),
        StatusCacheTTL:        l.viper.GetDuration("status_cache_ttl"),
        PreferFzf:             l.viper.GetBool("prefer_fzf"),
        AutoPruneOnRemove:     l.viper.GetBool("auto_prune_on_remove"),
    }

    // Validate
    if err := cfg.Validate(); err != nil {
        return nil, fmt.Errorf("invalid config: %w", err)
    }

    return cfg, nil
}

func getDefaultAIWorkingDir() string {
    // Check environment
    if dir := os.Getenv("AI_WORKING_DIR"); dir != "" {
        return dir
    }

    // Default: ~/amplifier/ai_working
    home, _ := os.UserHomeDir()
    return filepath.Join(home, "amplifier", "ai_working")
}
```

3. **Add validation:**
```go
// internal/config/validate.go
package config

import (
    "errors"
    "os"
)

func (c *Config) Validate() error {
    // Check ai_working_dir exists
    if _, err := os.Stat(c.AIWorkingDir); err != nil {
        return errors.New("ai_working_dir does not exist or is not accessible")
    }

    // Check worktree_pattern is valid
    validPatterns := map[string]bool{
        "patternA": true,
        "patternB": true,
        "patternC": true,
    }
    if !validPatterns[c.WorktreePattern] {
        return errors.New("worktree_pattern must be patternA, patternB, or patternC")
    }

    return nil
}
```

4. **Write tests:**
```go
// internal/config/loader_test.go
package config

import (
    "os"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestLoaderDefaults(t *testing.T) {
    // Setup
    tmpDir := t.TempDir()
    os.Setenv("AI_WORKING_DIR", tmpDir)
    defer os.Unsetenv("AI_WORKING_DIR")

    // Execute
    loader := NewLoader()
    cfg, err := loader.Load()

    // Verify
    require.NoError(t, err)
    assert.Equal(t, tmpDir, cfg.AIWorkingDir)
    assert.Equal(t, "main", cfg.DefaultBaseBranch)
    assert.Equal(t, "patternA", cfg.WorktreePattern)
}

func TestLoaderEnvOverride(t *testing.T) {
    // Setup
    tmpDir := t.TempDir()
    os.Setenv("AI_WORKING_DIR", tmpDir)
    os.Setenv("SWARM_DEFAULT_BASE_BRANCH", "develop")
    defer func() {
        os.Unsetenv("AI_WORKING_DIR")
        os.Unsetenv("SWARM_DEFAULT_BASE_BRANCH")
    }()

    // Execute
    loader := NewLoader()
    cfg, err := loader.Load()

    // Verify
    require.NoError(t, err)
    assert.Equal(t, "develop", cfg.DefaultBaseBranch)
}

func TestValidateInvalidDir(t *testing.T) {
    cfg := &Config{
        AIWorkingDir: "/nonexistent/path",
    }

    err := cfg.Validate()
    assert.Error(t, err)
    assert.Contains(t, err.Error(), "does not exist")
}
```

5. **Run tests:**
```bash
go test ./internal/config/... -v
```

**Validation:**
- [ ] Tests pass
- [ ] Can load from environment variables
- [ ] Can load from config file
- [ ] Validates invalid configurations
- [ ] Defaults work correctly

---

### Task 1.3: Git Module (6-8 hours)

**Objective:** Implement Git command wrapper and parser

**Reference:** See `MODULES.md` section 7 (git module contract)

**Steps:**

1. **Create Git types:**
```go
// internal/git/types.go
package git

import "time"

// WorktreeInfo from git worktree list --porcelain
type WorktreeInfo struct {
    Path     string
    Branch   string
    Commit   string
    Detached bool
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

// AddOptions for WorktreeAdd
type AddOptions struct {
    Path       string
    Branch     string
    BaseBranch string
    NewBranch  bool
}
```

2. **Implement Client:**
```go
// internal/git/client.go
package git

import (
    "bytes"
    "fmt"
    "os/exec"
    "strings"
)

type Client struct {
    parser *Parser
}

func NewClient() *Client {
    return &Client{
        parser: &Parser{},
    }
}

func (c *Client) WorktreeList(repoPath string) ([]WorktreeInfo, error) {
    cmd := exec.Command("git", "-C", repoPath, "worktree", "list", "--porcelain")
    output, err := cmd.CombinedOutput()
    if err != nil {
        return nil, fmt.Errorf("git worktree list failed: %w\nOutput: %s",
            err, output)
    }

    return c.parser.ParseWorktreeList(string(output))
}

func (c *Client) WorktreeAdd(repoPath string, opts AddOptions) error {
    args := []string{"-C", repoPath, "worktree", "add"}

    if opts.NewBranch {
        args = append(args, "-b", opts.Branch, opts.Path)
        if opts.BaseBranch != "" {
            args = append(args, opts.BaseBranch)
        }
    } else {
        args = append(args, opts.Path, opts.Branch)
    }

    cmd := exec.Command("git", args...)
    output, err := cmd.CombinedOutput()
    if err != nil {
        return fmt.Errorf("git worktree add failed: %w\nOutput: %s",
            err, output)
    }

    return nil
}

func (c *Client) WorktreeRemove(repoPath, worktreePath string) error {
    cmd := exec.Command("git", "-C", repoPath, "worktree", "remove", worktreePath)
    output, err := cmd.CombinedOutput()
    if err != nil {
        return fmt.Errorf("git worktree remove failed: %w\nOutput: %s",
            err, output)
    }

    return nil
}

func (c *Client) WorktreePrune(repoPath string) error {
    cmd := exec.Command("git", "-C", repoPath, "worktree", "prune")
    output, err := cmd.CombinedOutput()
    if err != nil {
        return fmt.Errorf("git worktree prune failed: %w\nOutput: %s",
            err, output)
    }

    return nil
}

func (c *Client) FetchAll(repoPath string) error {
    cmd := exec.Command("git", "-C", repoPath, "fetch", "--all", "--prune")
    output, err := cmd.CombinedOutput()
    if err != nil {
        return fmt.Errorf("git fetch failed: %w\nOutput: %s",
            err, output)
    }

    return nil
}

func (c *Client) Status(path string) (*StatusResult, error) {
    cmd := exec.Command("git", "-C", path, "status", "--porcelain")
    output, err := cmd.CombinedOutput()
    if err != nil {
        return nil, fmt.Errorf("git status failed: %w", err)
    }

    return c.parser.ParseStatus(string(output))
}

func (c *Client) DefaultBranch(repoPath string) (string, error) {
    // Try to read symbolic ref
    cmd := exec.Command("git", "-C", repoPath, "symbolic-ref",
        "refs/remotes/origin/HEAD", "--short")
    output, err := cmd.Output()
    if err == nil {
        branch := strings.TrimSpace(string(output))
        // origin/main -> main
        parts := strings.Split(branch, "/")
        if len(parts) > 1 {
            return parts[len(parts)-1], nil
        }
        return branch, nil
    }

    // Fallback: check common branch names
    for _, branch := range []string{"main", "master", "develop"} {
        cmd := exec.Command("git", "-C", repoPath, "rev-parse",
            "--verify", branch)
        if cmd.Run() == nil {
            return branch, nil
        }
    }

    return "", fmt.Errorf("could not determine default branch")
}
```

3. **Implement Parser:**
```go
// internal/git/parser.go
package git

import (
    "strings"
)

type Parser struct{}

func (p *Parser) ParseWorktreeList(output string) ([]WorktreeInfo, error) {
    var worktrees []WorktreeInfo
    var current *WorktreeInfo

    lines := strings.Split(output, "\n")
    for _, line := range lines {
        line = strings.TrimSpace(line)
        if line == "" {
            if current != nil {
                worktrees = append(worktrees, *current)
                current = nil
            }
            continue
        }

        parts := strings.SplitN(line, " ", 2)
        if len(parts) < 2 {
            continue
        }

        key, value := parts[0], parts[1]

        if key == "worktree" {
            current = &WorktreeInfo{Path: value}
        } else if current != nil {
            switch key {
            case "HEAD":
                current.Commit = value
            case "branch":
                // refs/heads/feature/foo -> feature/foo
                current.Branch = strings.TrimPrefix(value, "refs/heads/")
            case "detached":
                current.Detached = true
            }
        }
    }

    // Don't forget last one
    if current != nil {
        worktrees = append(worktrees, *current)
    }

    return worktrees, nil
}

func (p *Parser) ParseStatus(output string) (*StatusResult, error) {
    result := &StatusResult{}

    lines := strings.Split(output, "\n")
    for _, line := range lines {
        if len(line) < 4 {
            continue
        }

        status := line[0:2]
        file := strings.TrimSpace(line[3:])

        switch {
        case status[0] == 'M' || status[1] == 'M':
            result.Modified = append(result.Modified, file)
        case status[0] == 'A':
            result.Added = append(result.Added, file)
        case status[0] == 'D':
            result.Deleted = append(result.Deleted, file)
        case status == "??":
            result.Untracked = append(result.Untracked, file)
        }
    }

    return result, nil
}
```

4. **Write tests with fixtures:**
```go
// internal/git/parser_test.go
package git

import (
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestParseWorktreeList(t *testing.T) {
    output := `worktree /path/to/repo
HEAD abc123def456
branch refs/heads/main

worktree /path/to/repo__wt__feature_foo
HEAD def789ghi012
branch refs/heads/feature/foo

worktree /path/to/repo__wt__detached
HEAD 111222333444
detached
`

    parser := &Parser{}
    worktrees, err := parser.ParseWorktreeList(output)

    require.NoError(t, err)
    assert.Len(t, worktrees, 3)

    // First worktree
    assert.Equal(t, "/path/to/repo", worktrees[0].Path)
    assert.Equal(t, "main", worktrees[0].Branch)
    assert.False(t, worktrees[0].Detached)

    // Second worktree
    assert.Equal(t, "feature/foo", worktrees[1].Branch)
    assert.False(t, worktrees[1].Detached)

    // Third worktree
    assert.True(t, worktrees[2].Detached)
}

func TestParseStatus(t *testing.T) {
    output := ` M file1.txt
A  file2.txt
 D file3.txt
?? untracked.txt
`

    parser := &Parser{}
    status, err := parser.ParseStatus(output)

    require.NoError(t, err)
    assert.Contains(t, status.Modified, "file1.txt")
    assert.Contains(t, status.Added, "file2.txt")
    assert.Contains(t, status.Deleted, "file3.txt")
    assert.Contains(t, status.Untracked, "untracked.txt")
}
```

5. **Integration test (requires real git repo):**
```go
// internal/git/client_integration_test.go
// +build integration

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

    // Configure user
    exec.Command("git", "-C", repoPath, "config", "user.name", "Test").Run()
    exec.Command("git", "-C", repoPath, "config", "user.email", "test@test.com").Run()

    // Create initial commit
    os.WriteFile(filepath.Join(repoPath, "README.md"), []byte("# Test"), 0644)
    exec.Command("git", "-C", repoPath, "add", ".").Run()
    exec.Command("git", "-C", repoPath, "commit", "-m", "Initial commit").Run()

    return repoPath
}

func TestClientWorktreeLifecycle(t *testing.T) {
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

    // Remove worktree
    err = client.WorktreeRemove(repoPath, wtPath)
    require.NoError(t, err)
    assert.NoDirExists(t, wtPath)
}
```

6. **Run tests:**
```bash
# Unit tests (parser)
go test ./internal/git/... -v

# Integration tests (requires git)
go test ./internal/git/... -v -tags=integration
```

**Validation:**
- [ ] Parser tests pass
- [ ] Integration tests pass (create, list, remove)
- [ ] Error messages include git output
- [ ] Works with branches containing `/` in name

---

### Task 1.4: State Module (4-6 hours)

**Objective:** Implement JSON state persistence with file locking

**Reference:** See `MODULES.md` section 4 (state module contract)

**Steps:**

1. **Create state types:**
```go
// internal/state/types.go
package state

import "time"

// State represents the entire state file
type State struct {
    Version   int                   `json:"version"`
    UpdatedAt time.Time             `json:"updated_at"`
    Repos     map[string]*RepoState `json:"repos"`
}

// RepoState represents state for one repo
type RepoState struct {
    Path          string                    `json:"path"`
    DefaultBranch string                    `json:"default_branch"`
    LastScanned   time.Time                 `json:"last_scanned"`
    Worktrees     map[string]*WorktreeState `json:"worktrees"`
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

2. **Implement Store:**
```go
// internal/state/store.go
package state

import (
    "encoding/json"
    "fmt"
    "os"
    "path/filepath"
    "time"

    "github.com/gofrs/flock"
)

type Store struct {
    filePath string
    lockPath string
}

func NewStore(aiWorkingDir string) *Store {
    filePath := filepath.Join(aiWorkingDir, ".swarm-state.json")
    lockPath := filepath.Join(aiWorkingDir, ".swarm-state.lock")
    return &Store{
        filePath: filePath,
        lockPath: lockPath,
    }
}

func (s *Store) Load() (*State, error) {
    // Check if file exists
    if _, err := os.Stat(s.filePath); os.IsNotExist(err) {
        // Return empty state
        return &State{
            Version:   1,
            UpdatedAt: time.Now(),
            Repos:     make(map[string]*RepoState),
        }, nil
    }

    // Read file
    data, err := os.ReadFile(s.filePath)
    if err != nil {
        return nil, fmt.Errorf("reading state file: %w", err)
    }

    // Parse JSON
    var state State
    if err := json.Unmarshal(data, &state); err != nil {
        return nil, fmt.Errorf("parsing state file: %w", err)
    }

    return &state, nil
}

func (s *Store) Save(state *State) error {
    // Acquire lock
    lock := flock.New(s.lockPath)
    if err := lock.Lock(); err != nil {
        return fmt.Errorf("acquiring lock: %w", err)
    }
    defer lock.Unlock()

    // Update timestamp
    state.UpdatedAt = time.Now()

    // Marshal to JSON
    data, err := json.MarshalIndent(state, "", "  ")
    if err != nil {
        return fmt.Errorf("marshaling state: %w", err)
    }

    // Atomic write: write to temp file, then rename
    tmpPath := s.filePath + ".tmp"
    if err := os.WriteFile(tmpPath, data, 0644); err != nil {
        return fmt.Errorf("writing temp file: %w", err)
    }

    if err := os.Rename(tmpPath, s.filePath); err != nil {
        os.Remove(tmpPath) // Clean up
        return fmt.Errorf("renaming temp file: %w", err)
    }

    return nil
}

func (s *Store) UpdateWorktree(repoName string, wt *WorktreeState) error {
    // Load current state
    state, err := s.Load()
    if err != nil {
        return err
    }

    // Ensure repo exists
    if state.Repos[repoName] == nil {
        state.Repos[repoName] = &RepoState{
            Worktrees: make(map[string]*WorktreeState),
        }
    }

    // Update worktree
    state.Repos[repoName].Worktrees[wt.Slug] = wt

    // Save
    return s.Save(state)
}

func (s *Store) RemoveWorktree(repoName, slug string) error {
    state, err := s.Load()
    if err != nil {
        return err
    }

    if state.Repos[repoName] != nil {
        delete(state.Repos[repoName].Worktrees, slug)
    }

    return s.Save(state)
}
```

3. **Write tests:**
```go
// internal/state/store_test.go
package state

import (
    "path/filepath"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestStoreLoadEmpty(t *testing.T) {
    tmpDir := t.TempDir()
    store := NewStore(tmpDir)

    state, err := store.Load()
    require.NoError(t, err)
    assert.NotNil(t, state)
    assert.Equal(t, 1, state.Version)
    assert.Empty(t, state.Repos)
}

func TestStoreSaveLoad(t *testing.T) {
    tmpDir := t.TempDir()
    store := NewStore(tmpDir)

    // Create state
    state := &State{
        Version:   1,
        UpdatedAt: time.Now(),
        Repos: map[string]*RepoState{
            "test-repo": {
                Path:          "/path/to/repo",
                DefaultBranch: "main",
                Worktrees: map[string]*WorktreeState{
                    "feature_foo": {
                        Slug:      "feature_foo",
                        Branch:    "feature/foo",
                        Path:      "/path/to/worktree",
                        CreatedAt: time.Now(),
                    },
                },
            },
        },
    }

    // Save
    err := store.Save(state)
    require.NoError(t, err)

    // Verify file exists
    assert.FileExists(t, filepath.Join(tmpDir, ".swarm-state.json"))

    // Load
    loaded, err := store.Load()
    require.NoError(t, err)
    assert.Equal(t, "test-repo", loaded.Repos["test-repo"].Path)
    assert.Equal(t, "feature_foo", loaded.Repos["test-repo"].Worktrees["feature_foo"].Slug)
}

func TestStoreUpdateWorktree(t *testing.T) {
    tmpDir := t.TempDir()
    store := NewStore(tmpDir)

    // Update worktree (creates repo if needed)
    wt := &WorktreeState{
        Slug:      "feature_bar",
        Branch:    "feature/bar",
        Path:      "/path/to/bar",
        CreatedAt: time.Now(),
    }

    err := store.UpdateWorktree("test-repo", wt)
    require.NoError(t, err)

    // Verify
    state, _ := store.Load()
    assert.Contains(t, state.Repos, "test-repo")
    assert.Contains(t, state.Repos["test-repo"].Worktrees, "feature_bar")
}
```

**Validation:**
- [ ] Tests pass
- [ ] Atomic write works (temp + rename)
- [ ] File locking prevents race conditions
- [ ] Empty state loads correctly
- [ ] Save/load round-trips correctly

---

### Task 1.5: Repo Module (3-4 hours)

**Objective:** Implement repository discovery

**Reference:** See `MODULES.md` section 1 (repo module contract)

**Steps:**

1. **Create repo types:**
```go
// internal/repo/types.go
package repo

import "time"

// Repo represents a base repository
type Repo struct {
    Name          string
    Path          string
    DefaultBranch string
    LastScanned   time.Time
}
```

2. **Implement Discovery:**
```go
// internal/repo/discovery.go
package repo

import (
    "fmt"
    "os"
    "path/filepath"
    "strings"

    "github.com/microsoft/amplifier/swarm/internal/config"
    "github.com/microsoft/amplifier/swarm/internal/git"
)

type Discovery struct {
    config *config.Config
    git    *git.Client
}

func NewDiscovery(cfg *config.Config, gitClient *git.Client) *Discovery {
    return &Discovery{
        config: cfg,
        git:    gitClient,
    }
}

func (d *Discovery) ScanAll() ([]Repo, error) {
    entries, err := os.ReadDir(d.config.AIWorkingDir)
    if err != nil {
        return nil, fmt.Errorf("reading ai_working_dir: %w", err)
    }

    var repos []Repo
    for _, entry := range entries {
        if !entry.IsDir() {
            continue
        }

        // Skip worktree directories (contain __wt__)
        if strings.Contains(entry.Name(), "__wt__") {
            continue
        }

        repoPath := filepath.Join(d.config.AIWorkingDir, entry.Name())

        // Check if it's a git repo
        gitDir := filepath.Join(repoPath, ".git")
        if _, err := os.Stat(gitDir); err != nil {
            continue
        }

        // Get default branch
        defaultBranch, err := d.git.DefaultBranch(repoPath)
        if err != nil {
            defaultBranch = d.config.DefaultBaseBranch
        }

        repos = append(repos, Repo{
            Name:          entry.Name(),
            Path:          repoPath,
            DefaultBranch: defaultBranch,
        })
    }

    return repos, nil
}

func (d *Discovery) FindByName(name string) (*Repo, error) {
    repoPath := filepath.Join(d.config.AIWorkingDir, name)

    // Check if directory exists
    if _, err := os.Stat(repoPath); err != nil {
        return nil, fmt.Errorf("repo not found: %s", name)
    }

    // Check if it's a git repo
    gitDir := filepath.Join(repoPath, ".git")
    if _, err := os.Stat(gitDir); err != nil {
        return nil, fmt.Errorf("not a git repository: %s", name)
    }

    // Get default branch
    defaultBranch, err := d.git.DefaultBranch(repoPath)
    if err != nil {
        defaultBranch = d.config.DefaultBaseBranch
    }

    return &Repo{
        Name:          name,
        Path:          repoPath,
        DefaultBranch: defaultBranch,
    }, nil
}
```

3. **Write tests:**
```go
// internal/repo/discovery_test.go
package repo

import (
    "os"
    "os/exec"
    "path/filepath"
    "testing"

    "github.com/microsoft/amplifier/swarm/internal/config"
    "github.com/microsoft/amplifier/swarm/internal/git"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func setupTestRepos(t *testing.T) string {
    tmpDir := t.TempDir()

    // Create test repos
    for _, name := range []string{"repo1", "repo2"} {
        repoPath := filepath.Join(tmpDir, name)
        exec.Command("git", "init", repoPath).Run()
        exec.Command("git", "-C", repoPath, "config", "user.name", "Test").Run()
        exec.Command("git", "-C", repoPath, "config", "user.email", "test@test.com").Run()

        // Create initial commit
        os.WriteFile(filepath.Join(repoPath, "README.md"), []byte("# Test"), 0644)
        exec.Command("git", "-C", repoPath, "add", ".").Run()
        exec.Command("git", "-C", repoPath, "commit", "-m", "Initial").Run()
    }

    // Create a worktree directory (should be skipped)
    os.Mkdir(filepath.Join(tmpDir, "repo1__wt__feature"), 0755)

    // Create non-git directory (should be skipped)
    os.Mkdir(filepath.Join(tmpDir, "not-a-repo"), 0755)

    return tmpDir
}

func TestScanAll(t *testing.T) {
    tmpDir := setupTestRepos(t)

    cfg := &config.Config{
        AIWorkingDir:      tmpDir,
        DefaultBaseBranch: "main",
    }
    discovery := NewDiscovery(cfg, git.NewClient())

    repos, err := discovery.ScanAll()
    require.NoError(t, err)
    assert.Len(t, repos, 2) // repo1, repo2 (excludes worktree and non-git)

    names := []string{repos[0].Name, repos[1].Name}
    assert.Contains(t, names, "repo1")
    assert.Contains(t, names, "repo2")
}

func TestFindByName(t *testing.T) {
    tmpDir := setupTestRepos(t)

    cfg := &config.Config{
        AIWorkingDir: tmpDir,
    }
    discovery := NewDiscovery(cfg, git.NewClient())

    // Found
    repo, err := discovery.FindByName("repo1")
    require.NoError(t, err)
    assert.Equal(t, "repo1", repo.Name)
    assert.Contains(t, repo.Path, "repo1")

    // Not found
    _, err = discovery.FindByName("nonexistent")
    assert.Error(t, err)
    assert.Contains(t, err.Error(), "not found")
}
```

**Validation:**
- [ ] Tests pass
- [ ] Finds git repos correctly
- [ ] Skips worktree directories
- [ ] Skips non-git directories
- [ ] FindByName works

---

### Task 1.6: Worktree Module - Slug Generation (2-3 hours)

**Objective:** Implement slug generation with collision handling

**Steps:**

1. **Create slug generator:**
```go
// internal/worktree/slug.go
package worktree

import (
    "fmt"
    "regexp"
    "strings"
)

var (
    slugRegex = regexp.MustCompile(`[^a-zA-Z0-9_-]+`)
    maxSlugLength = 80
)

// GenerateSlug creates filesystem-safe slug from branch name
func GenerateSlug(branch string) string {
    // Replace / with _
    slug := strings.ReplaceAll(branch, "/", "_")

    // Remove unsafe characters
    slug = slugRegex.ReplaceAllString(slug, "_")

    // Collapse multiple underscores
    slug = regexp.MustCompile(`_+`).ReplaceAllString(slug, "_")

    // Trim leading/trailing underscores
    slug = strings.Trim(slug, "_")

    // Truncate if too long
    if len(slug) > maxSlugLength {
        slug = slug[:maxSlugLength]
        slug = strings.TrimRight(slug, "_")
    }

    return slug
}

// GenerateUniqueSlug generates slug and handles collisions
func GenerateUniqueSlug(branch string, existing map[string]string) string {
    base := GenerateSlug(branch)

    // Check if slug exists for same branch (reuse it)
    if existingBranch, ok := existing[base]; ok && existingBranch == branch {
        return base
    }

    // Check collision with different branch
    slug := base
    suffix := 2
    for {
        if existingBranch, ok := existing[slug]; !ok || existingBranch == branch {
            break
        }
        slug = fmt.Sprintf("%s_%d", base, suffix)
        suffix++
    }

    return slug
}
```

2. **Write comprehensive tests:**
```go
// internal/worktree/slug_test.go
package worktree

import (
    "testing"

    "github.com/stretchr/testify/assert"
)

func TestGenerateSlug(t *testing.T) {
    tests := []struct {
        name   string
        branch string
        want   string
    }{
        {
            name:   "simple",
            branch: "main",
            want:   "main",
        },
        {
            name:   "with slash",
            branch: "feature/foo",
            want:   "feature_foo",
        },
        {
            name:   "with multiple slashes",
            branch: "feature/sub/bar",
            want:   "feature_sub_bar",
        },
        {
            name:   "with special chars",
            branch: "bug/fix-#123",
            want:   "bug_fix-123",
        },
        {
            name:   "with spaces",
            branch: "feature with spaces",
            want:   "feature_with_spaces",
        },
        {
            name:   "collapse underscores",
            branch: "feature///foo",
            want:   "feature_foo",
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got := GenerateSlug(tt.branch)
            assert.Equal(t, tt.want, got)
        })
    }
}

func TestGenerateUniqueSlug(t *testing.T) {
    // Existing slugs
    existing := map[string]string{
        "feature_foo":   "feature/foo",
        "feature_foo_2": "feature/foo-v2",
    }

    tests := []struct {
        name   string
        branch string
        want   string
    }{
        {
            name:   "no collision",
            branch: "feature/bar",
            want:   "feature_bar",
        },
        {
            name:   "reuse existing slug for same branch",
            branch: "feature/foo",
            want:   "feature_foo",
        },
        {
            name:   "collision with different branch",
            branch: "feature/foo-v3",
            want:   "feature_foo_3", // _2 already taken
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got := GenerateUniqueSlug(tt.branch, existing)
            assert.Equal(t, tt.want, got)
        })
    }
}
```

**Validation:**
- [ ] All slug tests pass
- [ ] Handles special characters
- [ ] Truncates long names
- [ ] Collision detection works
- [ ] Reuses slug for same branch

---

Due to context window constraints, I'll create the remaining tasks in a separate continuation. Let me save this and continue with Task 1.7 onwards.

**Next Tasks to Complete (will be in continuation):**
- Task 1.7: Worktree Module - Manager (6-8 hours)
- Task 1.8: CLI Commands - Create (3-4 hours)
- Task 1.9: CLI Commands - List (2-3 hours)
- Task 1.10: CLI Commands - Open (2-3 hours)
- Task 1.11: CLI Commands - Remove (3-4 hours)
- Task 1.12: Integration Testing (4-6 hours)
- Task 1.13: Documentation & README (2-3 hours)

**Checkpoints for Phase 1 Completion:**
- [ ] All modules have contracts and implementation
- [ ] Unit tests pass (>80% coverage)
- [ ] Integration tests pass
- [ ] Can create worktree from CLI
- [ ] Can list worktrees from CLI
- [ ] Can open worktree (creates tmux session if needed)
- [ ] Can remove worktree safely
- [ ] README with quickstart guide
- [ ] All code follows Go conventions (gofmt, golint)

---

## Summary

Phase 1 establishes the foundation:
- **Config** loads settings
- **Git** wraps git commands
- **State** persists metadata
- **Repo** discovers repositories
- **Worktree** manages worktree lifecycle
- **CLI** provides `create`, `list`, `open`, `remove` commands

After Phase 1, you have a working CLI tool for basic worktree management. Phase 2 will add the TUI, safety checks, and tmux integration.
