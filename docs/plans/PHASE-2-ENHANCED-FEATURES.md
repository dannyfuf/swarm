# Phase 2: Enhanced Features & Safety

**Goal:** Add interactive TUI, comprehensive safety checks, enhanced tmux integration, and status computation to create a polished, production-ready tool.

**Duration Estimate:** 2-3 weeks for junior developer

**Prerequisites:** Phase 1 complete - all basic CLI commands working

**Deliverables:**
- Interactive TUI with Bubble Tea
- Comprehensive safety checks before destructive operations
- Enhanced tmux integration with custom layouts
- Status computation with caching
- Orphan detection and cleanup
- New commands: `tui`, `sessions`, `prune`

---

## Overview

Phase 2 transforms Swarm from a functional CLI tool into a polished, user-friendly application. The focus is on **preventing data loss**, **improving discoverability**, and **enhancing the user experience**.

### Key Improvements

```
Phase 1 (Basic CLI)           Phase 2 (Enhanced)
├─ create, list, open, remove  ├─ Interactive TUI
├─ Basic tmux sessions         ├─ Custom layouts
├─ JSON state                  ├─ Status computation
└─ No safety checks            ├─ Safety checks
                               ├─ Orphan detection
                               └─ Pruning
```

### Architecture Additions

Phase 2 adds these new modules:

```
┌─────────────────────────────────────────────────────────────┐
│                         TUI Layer                           │
│  (internal/tui/) - Interactive interface                    │
└───────────────────────┬─────────────────────────────────────┘
                        │
        ┌───────────────┼───────────────┬───────────────┐
        │               │               │               │
┌───────▼──────┐ ┌──────▼──────┐ ┌────▼──────┐ ┌──────▼─────┐
│   safety     │ │   status    │ │   tmux    │ │   orphan   │
│  (checks)    │ │  (compute)  │ │(enhanced) │ │  (detect)  │
└──────────────┘ └─────────────┘ └───────────┘ └────────────┘
```

---

## Task Breakdown

### Task 2.1: Safety Checker Module (6-8 hours)

**Objective:** Implement comprehensive safety checks before destructive operations

**Reference:** See ADR-006 in DECISIONS.md

**Steps:**

1. **Create safety types:**
```go
// internal/safety/safety.go
package safety

import "time"

// CheckResult represents safety check outcome
type CheckResult struct {
	Safe     bool
	Warnings []Warning
	Blockers []Blocker
	Metadata CheckMetadata
}

// Blocker prevents operation from proceeding
type Blocker struct {
	Type    BlockerType
	Message string
	Details string // Additional context
	Fix     string // Suggested fix
}

type BlockerType string

const (
	BlockerUncommittedChanges BlockerType = "uncommitted_changes"
	BlockerUnstagedChanges    BlockerType = "unstaged_changes"
)

// Warning doesn't prevent operation but should be noted
type Warning struct {
	Type    WarningType
	Message string
	Details string
}

type WarningType string

const (
	WarningUnpushedCommits WarningType = "unpushed_commits"
	WarningBranchNotMerged WarningType = "branch_not_merged"
	WarningOrphanedState   WarningType = "orphaned_state"
)

// CheckMetadata provides additional context
type CheckMetadata struct {
	CheckedAt        time.Time
	UncommittedFiles int
	UnpushedCommits  int
	BranchMerged     *bool // nil = unknown
}
```

2. **Implement Checker:**
```go
// internal/safety/checker.go
package safety

import (
	"fmt"
	"github.com/microsoft/amplifier/swarm/internal/git"
	"github.com/microsoft/amplifier/swarm/internal/worktree"
)

type Checker struct {
	git *git.Client
}

func NewChecker(gitClient *git.Client) *Checker {
	return &Checker{git: gitClient}
}

// CheckRemoval validates if worktree can be safely removed
func (c *Checker) CheckRemoval(wt *worktree.Worktree) (*CheckResult, error) {
	result := &CheckResult{
		Safe:     true,
		Warnings: []Warning{},
		Blockers: []Blocker{},
		Metadata: CheckMetadata{
			CheckedAt: time.Now(),
		},
	}

	// Check 1: Uncommitted changes
	status, err := c.git.Status(wt.Path)
	if err != nil {
		return nil, fmt.Errorf("checking git status: %w", err)
	}

	totalUncommitted := len(status.Modified) + len(status.Added) +
		len(status.Deleted) + len(status.Untracked)

	if totalUncommitted > 0 {
		result.Safe = false
		result.Blockers = append(result.Blockers, Blocker{
			Type:    BlockerUncommittedChanges,
			Message: fmt.Sprintf("Worktree has %d uncommitted file(s)", totalUncommitted),
			Details: c.formatChanges(status),
			Fix:     fmt.Sprintf("Commit or stash changes:\n  cd %s\n  git status", wt.Path),
		})
		result.Metadata.UncommittedFiles = totalUncommitted
	}

	// Check 2: Unpushed commits
	unpushedCount, err := c.countUnpushedCommits(wt)
	if err == nil && unpushedCount > 0 {
		result.Warnings = append(result.Warnings, Warning{
			Type:    WarningUnpushedCommits,
			Message: fmt.Sprintf("Branch has %d unpushed commit(s)", unpushedCount),
			Details: fmt.Sprintf("Push before removing:\n  cd %s\n  git push", wt.Path),
		})
		result.Metadata.UnpushedCommits = unpushedCount
	}

	// Check 3: Branch merged status (optional, may be slow)
	merged, err := c.isBranchMerged(wt)
	if err == nil {
		result.Metadata.BranchMerged = &merged
		if !merged {
			result.Warnings = append(result.Warnings, Warning{
				Type:    WarningBranchNotMerged,
				Message: "Branch has not been merged to default branch",
				Details: "This may indicate incomplete work",
			})
		}
	}

	return result, nil
}

func (c *Checker) formatChanges(status *git.StatusResult) string {
	var details string
	if len(status.Modified) > 0 {
		details += fmt.Sprintf("\nModified: %d files", len(status.Modified))
	}
	if len(status.Added) > 0 {
		details += fmt.Sprintf("\nAdded: %d files", len(status.Added))
	}
	if len(status.Deleted) > 0 {
		details += fmt.Sprintf("\nDeleted: %d files", len(status.Deleted))
	}
	if len(status.Untracked) > 0 {
		details += fmt.Sprintf("\nUntracked: %d files", len(status.Untracked))
	}
	return details
}

func (c *Checker) countUnpushedCommits(wt *worktree.Worktree) (int, error) {
	// Get unpushed commits
	commits, err := c.git.UnpushedCommits(wt.Path, wt.Branch)
	if err != nil {
		return 0, err
	}
	return len(commits), nil
}

func (c *Checker) isBranchMerged(wt *worktree.Worktree) (bool, error) {
	// Check if branch is merged into default branch
	return c.git.IsMerged(wt.Repo.Path, wt.Branch, wt.Repo.DefaultBranch)
}

// FormatResult returns human-readable safety check result
func FormatResult(result *CheckResult, color bool) string {
	var output string

	if !result.Safe {
		if color {
			output += "\033[31m⚠️  Cannot proceed:\033[0m\n"
		} else {
			output += "⚠️  Cannot proceed:\n"
		}

		for _, blocker := range result.Blockers {
			output += fmt.Sprintf("\n  • %s", blocker.Message)
			if blocker.Details != "" {
				output += fmt.Sprintf("\n    %s", blocker.Details)
			}
			if blocker.Fix != "" {
				output += fmt.Sprintf("\n\n    %s", blocker.Fix)
			}
		}
	}

	if len(result.Warnings) > 0 {
		output += "\n\n"
		if color {
			output += "\033[33m⚠️  Warnings:\033[0m\n"
		} else {
			output += "⚠️  Warnings:\n"
		}

		for _, warning := range result.Warnings {
			output += fmt.Sprintf("\n  • %s", warning.Message)
			if warning.Details != "" {
				output += fmt.Sprintf("\n    %s", warning.Details)
			}
		}
	}

	return output
}
```

3. **Add git helper methods:**
```go
// internal/git/safety.go
package git

// UnpushedCommits returns commits not yet pushed to remote
func (c *Client) UnpushedCommits(repoPath, branch string) ([]Commit, error) {
	// git log origin/<branch>..HEAD --oneline
	cmd := exec.Command("git", "-C", repoPath, "log",
		fmt.Sprintf("origin/%s..HEAD", branch),
		"--pretty=format:%H|%s|%an|%ad",
		"--date=iso")

	output, err := cmd.Output()
	if err != nil {
		// If remote branch doesn't exist, no unpushed commits
		if strings.Contains(string(output), "unknown revision") {
			return []Commit{}, nil
		}
		return nil, fmt.Errorf("getting unpushed commits: %w", err)
	}

	return c.parser.ParseCommits(string(output))
}

// IsMerged checks if branch is merged into target
func (c *Client) IsMerged(repoPath, branch, target string) (bool, error) {
	// git branch --contains <branch> | grep <target>
	cmd := exec.Command("git", "-C", repoPath, "branch",
		"--contains", branch)

	output, err := cmd.Output()
	if err != nil {
		return false, fmt.Errorf("checking if merged: %w", err)
	}

	return strings.Contains(string(output), target), nil
}
```

4. **Update git parser:**
```go
// internal/git/parser.go additions
func (p *Parser) ParseCommits(output string) ([]Commit, error) {
	var commits []Commit

	lines := strings.Split(output, "\n")
	for _, line := range lines {
		if line == "" {
			continue
		}

		parts := strings.Split(line, "|")
		if len(parts) < 4 {
			continue
		}

		date, _ := time.Parse("2006-01-02 15:04:05 -0700", parts[3])

		commits = append(commits, Commit{
			Hash:    parts[0],
			Message: parts[1],
			Author:  parts[2],
			Date:    date,
		})
	}

	return commits, nil
}
```

5. **Integrate with remove command:**
```go
// cmd/remove.go additions
func runRemove(cmd *cobra.Command, args []string) error {
	repoName := args[0]
	branch := args[1]

	// ... existing code to find worktree ...

	// Safety checks (unless --force)
	if !removeFlags.force {
		checker := safety.NewChecker(gitClient)
		result, err := checker.CheckRemoval(targetWt)
		if err != nil {
			return fmt.Errorf("safety check failed: %w", err)
		}

		if !result.Safe {
			// Print blockers
			fmt.Println(safety.FormatResult(result, true))
			fmt.Println("\nUse --force to remove anyway")
			return fmt.Errorf("removal blocked by safety checks")
		}

		// Print warnings but allow to continue
		if len(result.Warnings) > 0 {
			fmt.Println(safety.FormatResult(result, true))
			fmt.Print("\nContinue? [y/N]: ")

			var response string
			fmt.Scanln(&response)
			if response != "y" && response != "Y" {
				return fmt.Errorf("removal cancelled by user")
			}
		}
	}

	// ... proceed with removal ...
}
```

6. **Write comprehensive tests:**
```go
// internal/safety/checker_test.go
package safety

import (
	"testing"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCheckerWithCleanWorktree(t *testing.T) {
	// Setup mock worktree with no changes
	wt := setupCleanWorktree(t)

	checker := NewChecker(git.NewClient())
	result, err := checker.CheckRemoval(wt)

	require.NoError(t, err)
	assert.True(t, result.Safe)
	assert.Empty(t, result.Blockers)
}

func TestCheckerWithUncommittedChanges(t *testing.T) {
	// Setup worktree with uncommitted files
	wt := setupWorktreeWithChanges(t)

	checker := NewChecker(git.NewClient())
	result, err := checker.CheckRemoval(wt)

	require.NoError(t, err)
	assert.False(t, result.Safe)
	assert.Len(t, result.Blockers, 1)
	assert.Equal(t, BlockerUncommittedChanges, result.Blockers[0].Type)
}

func TestCheckerWithUnpushedCommits(t *testing.T) {
	// Setup worktree with unpushed commits
	wt := setupWorktreeWithUnpushed(t)

	checker := NewChecker(git.NewClient())
	result, err := checker.CheckRemoval(wt)

	require.NoError(t, err)
	assert.True(t, result.Safe) // Warnings don't block
	assert.Len(t, result.Warnings, 1)
	assert.Equal(t, WarningUnpushedCommits, result.Warnings[0].Type)
}
```

**Validation:**
- [ ] Tests pass for all safety check scenarios
- [ ] Uncommitted changes block removal
- [ ] Unpushed commits show warning
- [ ] --force bypasses safety checks
- [ ] Error messages are clear and actionable

---

### Task 2.2: Status Computation Module (4-6 hours)

**Objective:** Compute and cache worktree status efficiently

**Steps:**

1. **Create status types:**
```go
// internal/status/status.go
package status

import (
	"sync"
	"time"
)

// Status represents computed worktree status
type Status struct {
	HasChanges   bool
	HasUnpushed  bool
	BranchMerged *bool // nil = unknown
	IsOrphaned   bool

	// Cached data
	computedAt time.Time
	ttl        time.Duration
}

// Computer computes status with caching
type Computer struct {
	cache      map[string]*Status // key: worktree path
	cacheMutex sync.RWMutex
	ttl        time.Duration
	git        *git.Client
}

func NewComputer(gitClient *git.Client, ttl time.Duration) *Computer {
	return &Computer{
		cache: make(map[string]*Status),
		ttl:   ttl,
		git:   gitClient,
	}
}
```

2. **Implement computation with caching:**
```go
// internal/status/computer.go
func (c *Computer) Compute(wt *worktree.Worktree) (*Status, error) {
	// Check cache first
	c.cacheMutex.RLock()
	cached, exists := c.cache[wt.Path]
	c.cacheMutex.RUnlock()

	if exists && time.Since(cached.computedAt) < c.ttl {
		return cached, nil
	}

	// Compute fresh status
	status := &Status{
		computedAt: time.Now(),
		ttl:        c.ttl,
	}

	// Check for changes
	gitStatus, err := c.git.Status(wt.Path)
	if err != nil {
		return nil, fmt.Errorf("getting git status: %w", err)
	}

	totalChanges := len(gitStatus.Modified) + len(gitStatus.Added) +
		len(gitStatus.Deleted) + len(gitStatus.Untracked)
	status.HasChanges = totalChanges > 0

	// Check for unpushed commits
	unpushed, err := c.git.UnpushedCommits(wt.Path, wt.Branch)
	if err == nil {
		status.HasUnpushed = len(unpushed) > 0
	}

	// Check if merged (optional, slow)
	if c.ttl > 5*time.Minute {
		merged, err := c.git.IsMerged(wt.Repo.Path, wt.Branch, wt.Repo.DefaultBranch)
		if err == nil {
			status.BranchMerged = &merged
		}
	}

	// Update cache
	c.cacheMutex.Lock()
	c.cache[wt.Path] = status
	c.cacheMutex.Unlock()

	return status, nil
}

// ComputeAll computes status for multiple worktrees in parallel
func (c *Computer) ComputeAll(worktrees []worktree.Worktree) map[string]*Status {
	results := make(map[string]*Status)
	var mutex sync.Mutex
	var wg sync.WaitGroup

	// Worker pool
	jobs := make(chan worktree.Worktree, len(worktrees))
	workers := min(runtime.NumCPU(), 4) // Limit to 4 workers

	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for wt := range jobs {
				status, err := c.Compute(&wt)
				if err == nil {
					mutex.Lock()
					results[wt.Path] = status
					mutex.Unlock()
				}
			}
		}()
	}

	// Distribute work
	for _, wt := range worktrees {
		jobs <- wt
	}
	close(jobs)

	wg.Wait()
	return results
}

// InvalidateCache clears cached status
func (c *Computer) InvalidateCache(path string) {
	c.cacheMutex.Lock()
	delete(c.cache, path)
	c.cacheMutex.Unlock()
}

// ClearCache clears all cached status
func (c *Computer) ClearCache() {
	c.cacheMutex.Lock()
	c.cache = make(map[string]*Status)
	c.cacheMutex.Unlock()
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
```

3. **Add status badges:**
```go
// internal/status/badge.go
package status

// Badge represents a visual status indicator
type Badge struct {
	Symbol string
	Color  string
	Hint   string
}

// GetBadges returns visual indicators for status
func (s *Status) GetBadges() []Badge {
	var badges []Badge

	if s.HasChanges {
		badges = append(badges, Badge{
			Symbol: "●",
			Color:  "yellow",
			Hint:   "uncommitted changes",
		})
	}

	if s.HasUnpushed {
		badges = append(badges, Badge{
			Symbol: "↑",
			Color:  "cyan",
			Hint:   "unpushed commits",
		})
	}

	if s.BranchMerged != nil && *s.BranchMerged {
		badges = append(badges, Badge{
			Symbol: "✓",
			Color:  "green",
			Hint:   "merged",
		})
	}

	if s.IsOrphaned {
		badges = append(badges, Badge{
			Symbol: "⚠",
			Color:  "red",
			Hint:   "orphaned",
		})
	}

	return badges
}
```

**Validation:**
- [ ] Status computation works correctly
- [ ] Cache reduces redundant git calls
- [ ] Parallel computation improves performance
- [ ] Cache invalidation works after mutations

---

### Task 2.3: Orphan Detection (2-3 hours)

**Objective:** Detect and clean worktrees that exist in state but not in git

**Steps:**

1. **Implement detection:**
```go
// internal/worktree/orphan.go
package worktree

import "time"

// OrphanDetector finds inconsistencies between state and git
type OrphanDetector struct {
	git   *git.Client
	state *state.Store
}

func NewOrphanDetector(gitClient *git.Client, stateStore *state.Store) *OrphanDetector {
	return &OrphanDetector{
		git:   gitClient,
		state: stateStore,
	}
}

// DetectOrphans finds worktrees in state but not in git
func (d *OrphanDetector) DetectOrphans(repo *repo.Repo) ([]OrphanedWorktree, error) {
	// Get git reality
	gitWorktrees, err := d.git.WorktreeList(repo.Path)
	if err != nil {
		return nil, fmt.Errorf("listing git worktrees: %w", err)
	}

	// Build set of git paths
	gitPaths := make(map[string]bool)
	for _, wt := range gitWorktrees {
		gitPaths[wt.Path] = true
	}

	// Load state
	st, err := d.state.Load()
	if err != nil {
		return nil, fmt.Errorf("loading state: %w", err)
	}

	repoState := st.Repos[repo.Name]
	if repoState == nil {
		return []OrphanedWorktree{}, nil
	}

	// Find orphans
	var orphans []OrphanedWorktree
	for slug, wtState := range repoState.Worktrees {
		if !gitPaths[wtState.Path] {
			orphans = append(orphans, OrphanedWorktree{
				Slug:      slug,
				Branch:    wtState.Branch,
				Path:      wtState.Path,
				CreatedAt: wtState.CreatedAt,
				Reason:    "Not in git worktree list",
			})
		}
	}

	return orphans, nil
}

// OrphanedWorktree represents a stale state entry
type OrphanedWorktree struct {
	Slug      string
	Branch    string
	Path      string
	CreatedAt time.Time
	Reason    string
}

// CleanOrphans removes orphaned entries from state
func (d *OrphanDetector) CleanOrphans(repo *repo.Repo, orphans []OrphanedWorktree) error {
	if len(orphans) == 0 {
		return nil
	}

	st, err := d.state.Load()
	if err != nil {
		return fmt.Errorf("loading state: %w", err)
	}

	repoState := st.Repos[repo.Name]
	if repoState == nil {
		return nil
	}

	// Remove each orphan
	for _, orphan := range orphans {
		delete(repoState.Worktrees, orphan.Slug)
	}

	// Save updated state
	return d.state.Save(st)
}
```

2. **Add prune command:**
```go
// cmd/prune.go
package cmd

import (
	"fmt"
	"github.com/spf13/cobra"
)

var pruneCmd = &cobra.Command{
	Use:   "prune [repo]",
	Short: "Clean up stale worktree state",
	Long: `Remove worktrees from state that no longer exist in git.

Examples:
  swarm prune my-project    # Prune specific repo
  swarm prune --all           # Prune all repos`,
	Args: cobra.MaximumNArgs(1),
	RunE: runPrune,
}

var pruneFlags struct {
	all    bool
	dryRun bool
}

func init() {
	rootCmd.AddCommand(pruneCmd)
	pruneCmd.Flags().BoolVar(&pruneFlags.all, "all", false, "Prune all repos")
	pruneCmd.Flags().BoolVar(&pruneFlags.dryRun, "dry-run", false, "Show what would be pruned")
}

func runPrune(cmd *cobra.Command, args []string) error {
	// Load config
	loader := config.NewLoader()
	cfg, err := loader.Load()
	if err != nil {
		return fmt.Errorf("loading config: %w", err)
	}

	// Initialize dependencies
	gitClient := git.NewClient()
	stateStore := state.NewStore(cfg.AIWorkingDir)
	discovery := repo.NewDiscovery(cfg, gitClient)
	detector := worktree.NewOrphanDetector(gitClient, stateStore)

	// Determine which repos to prune
	var repos []repo.Repo
	if pruneFlags.all {
		repos, err = discovery.ScanAll()
		if err != nil {
			return fmt.Errorf("scanning repos: %w", err)
		}
	} else if len(args) > 0 {
		r, err := discovery.FindByName(args[0])
		if err != nil {
			return fmt.Errorf("finding repo: %w", err)
		}
		repos = []repo.Repo{*r}
	} else {
		return fmt.Errorf("specify repo name or use --all")
	}

	// Prune each repo
	totalOrphans := 0
	for _, r := range repos {
		orphans, err := detector.DetectOrphans(&r)
		if err != nil {
			fmt.Printf("Error detecting orphans in %s: %v\n", r.Name, err)
			continue
		}

		if len(orphans) == 0 {
			fmt.Printf("✓ %s: No orphaned worktrees\n", r.Name)
			continue
		}

		fmt.Printf("\n%s: Found %d orphaned worktree(s)\n", r.Name, len(orphans))
		for _, orphan := range orphans {
			fmt.Printf("  • %s (branch: %s)\n", orphan.Slug, orphan.Branch)
			fmt.Printf("    Path: %s\n", orphan.Path)
			fmt.Printf("    Reason: %s\n", orphan.Reason)
		}

		if !pruneFlags.dryRun {
			if err := detector.CleanOrphans(&r, orphans); err != nil {
				fmt.Printf("Error cleaning orphans: %v\n", err)
				continue
			}
			fmt.Printf("✓ Cleaned %d orphaned worktree(s) from state\n", len(orphans))
		}

		totalOrphans += len(orphans)
	}

	if pruneFlags.dryRun {
		fmt.Printf("\nDry run: Would remove %d orphaned worktree(s)\n", totalOrphans)
		fmt.Println("Run without --dry-run to actually clean")
	} else {
		fmt.Printf("\n✓ Pruned %d total orphaned worktree(s)\n", totalOrphans)
	}

	return nil
}
```

**Validation:**
- [ ] Correctly detects orphaned state
- [ ] Cleans orphans from state file
- [ ] --dry-run shows what would be removed
- [ ] Works with single repo or --all flag

---

### Task 2.4: Enhanced Tmux Integration (4-6 hours)

**Objective:** Add custom layout support and improved session management

**Steps:**

1. **Create layout system:**
```go
// internal/tmux/layout.go
package tmux

// Layout defines tmux window/pane structure
type Layout struct {
	Windows []Window
}

// Window represents a tmux window
type Window struct {
	Name    string
	Command string // Initial command to run
	Panes   []Pane
}

// Pane represents a split within a window
type Pane struct {
	Command   string
	Direction string // "horizontal" or "vertical"
	Size      int    // Percentage (e.g., 50 for 50%)
}

// DefaultLayout returns standard 3-window layout
func DefaultLayout() *Layout {
	return &Layout{
		Windows: []Window{
			{
				Name:    "editor",
				Command: "nvim .",
				Panes:   []Pane{},
			},
			{
				Name:    "shell",
				Command: "",
				Panes:   []Pane{},
			},
			{
				Name:    "tests",
				Command: "make test",
				Panes: []Pane{
					{
						Command:   "make watch",
						Direction: "vertical",
						Size:      50,
					},
				},
			},
		},
	}
}

// Apply applies layout to existing session
func (l *Layout) Apply(sessionName string) error {
	client := NewClient()

	for i, window := range l.Windows {
		windowNum := i + 1
		windowTarget := fmt.Sprintf("%s:%d", sessionName, windowNum)

		// Create window (first window already exists)
		if i > 0 {
			cmd := exec.Command("tmux", "new-window",
				"-t", sessionName,
				"-n", window.Name)
			if err := cmd.Run(); err != nil {
				return fmt.Errorf("creating window %d: %w", windowNum, err)
			}
		} else {
			// Rename first window
			cmd := exec.Command("tmux", "rename-window",
				"-t", windowTarget, window.Name)
			if err := cmd.Run(); err != nil {
				return fmt.Errorf("renaming window 1: %w", err)
			}
		}

		// Run initial command in main pane
		if window.Command != "" {
			cmd := exec.Command("tmux", "send-keys",
				"-t", windowTarget, window.Command, "Enter")
			if err := cmd.Run(); err != nil {
				return fmt.Errorf("sending command to window %d: %w", windowNum, err)
			}
		}

		// Create additional panes
		for j, pane := range window.Panes {
			splitFlag := "-h" // horizontal
			if pane.Direction == "vertical" {
				splitFlag = "-v"
			}

			splitCmd := []string{"split-window", splitFlag, "-t", windowTarget}
			if pane.Size > 0 {
				splitCmd = append(splitCmd, "-p", fmt.Sprintf("%d", pane.Size))
			}

			cmd := exec.Command("tmux", splitCmd...)
			if err := cmd.Run(); err != nil {
				return fmt.Errorf("creating pane %d in window %d: %w", j+1, windowNum, err)
			}

			// Run command in pane
			if pane.Command != "" {
				paneTarget := fmt.Sprintf("%s.%d", windowTarget, j+1)
				cmd := exec.Command("tmux", "send-keys",
					"-t", paneTarget, pane.Command, "Enter")
				if err := cmd.Run(); err != nil {
					return fmt.Errorf("sending command to pane: %w", err)
				}
			}
		}
	}

	// Select first window
	cmd := exec.Command("tmux", "select-window", "-t", fmt.Sprintf("%s:1", sessionName))
	cmd.Run()

	return nil
}
```

2. **Add custom layout loading:**
```go
// internal/tmux/loader.go
package tmux

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// LoadLayout loads custom layout from config
func LoadLayout(configPath string) (*Layout, error) {
	if configPath == "" {
		return DefaultLayout(), nil
	}

	// Check if it's a script
	if filepath.Ext(configPath) == ".sh" {
		return loadFromScript(configPath)
	}

	// Load as JSON
	return loadFromJSON(configPath)
}

func loadFromJSON(path string) (*Layout, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading layout file: %w", err)
	}

	var layout Layout
	if err := json.Unmarshal(data, &layout); err != nil {
		return nil, fmt.Errorf("parsing layout JSON: %w", err)
	}

	return &layout, nil
}

func loadFromScript(scriptPath string) (*Layout, error) {
	// Script should output JSON layout to stdout
	cmd := exec.Command(scriptPath)
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("executing layout script: %w", err)
	}

	var layout Layout
	if err := json.Unmarshal(output, &layout); err != nil {
		return nil, fmt.Errorf("parsing script output: %w", err)
	}

	return &layout, nil
}
```

3. **Update open command to use layouts:**
```go
// cmd/open.go additions
func runOpen(cmd *cobra.Command, args []string) error {
	// ... existing code ...

	// Load layout
	layout, err := tmux.LoadLayout(cfg.TmuxLayoutScript)
	if err != nil {
		fmt.Printf("Warning: failed to load layout, using default: %v\n", err)
		layout = tmux.DefaultLayout()
	}

	// Create session with layout
	opts := tmux.CreateOptions{
		Name:   sessionName,
		Path:   targetWt.Path,
		Layout: layout,
	}

	if err := tmuxClient.CreateWithLayout(opts); err != nil {
		return fmt.Errorf("creating tmux session: %w", err)
	}

	// ... rest of existing code ...
}
```

4. **Add sessions command:**
```go
// cmd/sessions.go
package cmd

import (
	"fmt"
	"github.com/spf13/cobra"
)

var sessionsCmd = &cobra.Command{
	Use:   "sessions",
	Short: "List all tmux sessions",
	Long:  `Show all active tmux sessions managed by swarm.`,
	RunE:  runSessions,
}

var sessionsFlags struct {
	all bool
}

func init() {
	rootCmd.AddCommand(sessionsCmd)
	sessionsCmd.Flags().BoolVar(&sessionsFlags.all, "all", false,
		"Show all tmux sessions (not just swarm)")
}

func runSessions(cmd *cobra.Command, args []string) error {
	tmuxClient := tmux.NewClient()

	sessions, err := tmuxClient.ListSessions()
	if err != nil {
		return fmt.Errorf("listing sessions: %w", err)
	}

	if len(sessions) == 0 {
		fmt.Println("No active tmux sessions")
		return nil
	}

	// Filter to swarm sessions (contain "__wt__") unless --all
	var displaySessions []tmux.Session
	for _, session := range sessions {
		if sessionsFlags.all || strings.Contains(session.Name, "__wt__") {
			displaySessions = append(displaySessions, session)
		}
	}

	fmt.Printf("Active sessions (%d):\n\n", len(displaySessions))
	for _, session := range displaySessions {
		status := " "
		if session.Attached {
			status = "●"
		}

		fmt.Printf("  %s %s\n", status, session.Name)
		fmt.Printf("    Path: %s\n", session.Path)
		fmt.Printf("    Windows: %d\n", len(session.Windows))
		if session.Attached {
			fmt.Printf("    Status: attached\n")
		}
		fmt.Println()
	}

	return nil
}
```

**Validation:**
- [ ] Default layout works correctly
- [ ] Custom JSON layouts load and apply
- [ ] Script-based layouts work
- [ ] Sessions command lists active sessions
- [ ] Layout errors fall back gracefully

---

### Task 2.5: TUI Foundation (8-10 hours)

**Objective:** Implement interactive terminal UI with Bubble Tea

**Reference:** Bubble Tea documentation and examples

**Steps:**

1. **Install Bubble Tea dependencies:**
```bash
go get github.com/charmbracelet/bubbletea@latest
go get github.com/charmbracelet/bubbles@latest
go get github.com/charmbracelet/lipgloss@latest
```

2. **Create TUI model:**
```go
// internal/tui/model.go
package tui

import (
	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/list"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/microsoft/amplifier/swarm/internal/repo"
	"github.com/microsoft/amplifier/swarm/internal/worktree"
)

// Model represents the TUI state
type Model struct {
	// Views
	repoList      list.Model
	worktreeList  list.Model
	detailView    string

	// Data
	repos         []repo.Repo
	worktrees     []worktree.Worktree
	selectedRepo  *repo.Repo
	selectedWT    *worktree.Worktree

	// State
	focusedPanel  Panel
	width         int
	height        int

	// Dependencies
	repoDiscovery *repo.Discovery
	wtManager     *worktree.Manager
	statusComputer *status.Computer
}

type Panel int

const (
	PanelRepos Panel = iota
	PanelWorktrees
	PanelDetail
)

// New creates a new TUI model
func New(
	discovery *repo.Discovery,
	wtManager *worktree.Manager,
	statusComputer *status.Computer,
) Model {
	return Model{
		repoDiscovery:  discovery,
		wtManager:      wtManager,
		statusComputer: statusComputer,
		focusedPanel:   PanelRepos,
	}
}
```

3. **Implement Bubble Tea methods:**
```go
// internal/tui/update.go
package tui

import (
	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"
)

// Init initializes the model
func (m Model) Init() tea.Cmd {
	return tea.Batch(
		loadReposCmd(m.repoDiscovery),
		tea.EnterAltScreen,
	)
}

// Update handles messages
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		return m.handleKeyMsg(msg)

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil

	case reposLoadedMsg:
		m.repos = msg.repos
		m.repoList = createRepoList(msg.repos)
		return m, nil

	case worktreesLoadedMsg:
		m.worktrees = msg.worktrees
		m.worktreeList = createWorktreeList(msg.worktrees)
		return m, nil
	}

	return m, nil
}

func (m Model) handleKeyMsg(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit

	case "tab":
		m.focusedPanel = (m.focusedPanel + 1) % 3
		return m, nil

	case "enter":
		return m.handleEnter()

	case "n":
		return m.handleNew()

	case "d":
		return m.handleDelete()

	case "o":
		return m.handleOpen()

	case "r":
		return m.handleRefresh()

	case "?":
		return m.handleHelp()
	}

	// Delegate to focused list
	switch m.focusedPanel {
	case PanelRepos:
		newList, cmd := m.repoList.Update(msg)
		m.repoList = newList
		return m, cmd

	case PanelWorktrees:
		newList, cmd := m.worktreeList.Update(msg)
		m.worktreeList = newList
		return m, cmd
	}

	return m, nil
}

func (m Model) handleEnter() (tea.Model, tea.Cmd) {
	switch m.focusedPanel {
	case PanelRepos:
		// Load worktrees for selected repo
		if item := m.repoList.SelectedItem(); item != nil {
			repoItem := item.(repoItem)
			m.selectedRepo = &repoItem.repo
			return m, loadWorktreesCmd(m.wtManager, m.selectedRepo)
		}

	case PanelWorktrees:
		// Select worktree for detail view
		if item := m.worktreeList.SelectedItem(); item != nil {
			wtItem := item.(worktreeItem)
			m.selectedWT = &wtItem.worktree
			m.detailView = renderDetail(m.selectedWT, m.statusComputer)
		}
	}

	return m, nil
}

// ... implement other handlers ...
```

4. **Implement view rendering:**
```go
// internal/tui/view.go
package tui

import (
	"fmt"
	"github.com/charmbracelet/lipgloss"
)

// View renders the TUI
func (m Model) View() string {
	if m.width == 0 {
		return "Loading..."
	}

	// Layout: three columns
	colWidth := m.width / 3

	repoPanel := renderPanel("Repositories", m.repoList.View(),
		colWidth, m.height-2, m.focusedPanel == PanelRepos)

	wtPanel := renderPanel("Worktrees", m.worktreeList.View(),
		colWidth, m.height-2, m.focusedPanel == PanelWorktrees)

	detailPanel := renderPanel("Details", m.detailView,
		colWidth, m.height-2, m.focusedPanel == PanelDetail)

	mainView := lipgloss.JoinHorizontal(lipgloss.Top,
		repoPanel, wtPanel, detailPanel)

	statusBar := renderStatusBar(m)

	return lipgloss.JoinVertical(lipgloss.Left, mainView, statusBar)
}

func renderPanel(title, content string, width, height int, focused bool) string {
	borderStyle := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("240")).
		Width(width).
		Height(height)

	if focused {
		borderStyle = borderStyle.
			BorderForeground(lipgloss.Color("69"))
	}

	titleStyle := lipgloss.NewStyle().
		Bold(true).
		Foreground(lipgloss.Color("63")).
		Padding(0, 1)

	return borderStyle.Render(
		lipgloss.JoinVertical(lipgloss.Left,
			titleStyle.Render(title),
			content,
		),
	)
}

func renderStatusBar(m Model) string {
	style := lipgloss.NewStyle().
		Foreground(lipgloss.Color("240")).
		Background(lipgloss.Color("235")).
		Padding(0, 1)

	keys := "q: quit | tab: switch panel | enter: select | n: new | o: open | d: delete | r: refresh | ?: help"

	return style.Width(m.width).Render(keys)
}

func renderDetail(wt *worktree.Worktree, computer *status.Computer) string {
	if wt == nil {
		return "Select a worktree to view details"
	}

	status, err := computer.Compute(wt)
	if err != nil {
		return fmt.Sprintf("Error computing status: %v", err)
	}

	var content string
	content += fmt.Sprintf("Branch: %s\n", wt.Branch)
	content += fmt.Sprintf("Slug: %s\n", wt.Slug)
	content += fmt.Sprintf("Path: %s\n\n", wt.Path)

	content += "Status:\n"
	badges := status.GetBadges()
	for _, badge := range badges {
		content += fmt.Sprintf("  %s %s\n", badge.Symbol, badge.Hint)
	}

	if len(badges) == 0 {
		content += "  ✓ Clean\n"
	}

	content += fmt.Sprintf("\nCreated: %s\n", wt.CreatedAt.Format("2006-01-02 15:04"))
	if !wt.LastOpened.IsZero() {
		content += fmt.Sprintf("Last opened: %s\n", wt.LastOpened.Format("2006-01-02 15:04"))
	}

	return content
}
```

5. **Implement list items:**
```go
// internal/tui/items.go
package tui

import (
	"fmt"
	"github.com/charmbracelet/bubbles/list"
	"github.com/microsoft/amplifier/swarm/internal/repo"
	"github.com/microsoft/amplifier/swarm/internal/worktree"
)

// repoItem implements list.Item
type repoItem struct {
	repo repo.Repo
}

func (i repoItem) Title() string {
	return i.repo.Name
}

func (i repoItem) Description() string {
	return i.repo.Path
}

func (i repoItem) FilterValue() string {
	return i.repo.Name
}

// worktreeItem implements list.Item
type worktreeItem struct {
	worktree worktree.Worktree
	status   *status.Status
}

func (i worktreeItem) Title() string {
	title := i.worktree.Branch

	if i.status != nil {
		badges := i.status.GetBadges()
		for _, badge := range badges {
			title += fmt.Sprintf(" %s", badge.Symbol)
		}
	}

	return title
}

func (i worktreeItem) Description() string {
	return i.worktree.Slug
}

func (i worktreeItem) FilterValue() string {
	return i.worktree.Branch + " " + i.worktree.Slug
}

func createRepoList(repos []repo.Repo) list.Model {
	items := make([]list.Item, len(repos))
	for i, r := range repos {
		items[i] = repoItem{repo: r}
	}

	l := list.New(items, list.NewDefaultDelegate(), 0, 0)
	l.Title = "Repositories"
	return l
}

func createWorktreeList(worktrees []worktree.Worktree) list.Model {
	items := make([]list.Item, len(worktrees))
	for i, wt := range worktrees {
		items[i] = worktreeItem{worktree: wt}
	}

	l := list.New(items, list.NewDefaultDelegate(), 0, 0)
	l.Title = "Worktrees"
	return l
}
```

6. **Implement async commands:**
```go
// internal/tui/commands.go
package tui

import (
	tea "github.com/charmbracelet/bubbletea"
)

type reposLoadedMsg struct {
	repos []repo.Repo
}

type worktreesLoadedMsg struct {
	worktrees []worktree.Worktree
}

func loadReposCmd(discovery *repo.Discovery) tea.Cmd {
	return func() tea.Msg {
		repos, err := discovery.ScanAll()
		if err != nil {
			return errorMsg{err}
		}
		return reposLoadedMsg{repos: repos}
	}
}

func loadWorktreesCmd(manager *worktree.Manager, repo *repo.Repo) tea.Cmd {
	return func() tea.Msg {
		worktrees, err := manager.List(repo)
		if err != nil {
			return errorMsg{err}
		}
		return worktreesLoadedMsg{worktrees: worktrees}
	}
}

type errorMsg struct {
	err error
}
```

7. **Add tui command:**
```go
// cmd/tui.go
package cmd

import (
	"fmt"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/spf13/cobra"
)

var tuiCmd = &cobra.Command{
	Use:   "tui",
	Short: "Launch interactive terminal UI",
	Long:  `Open an interactive TUI for browsing and managing worktrees.`,
	RunE:  runTUI,
}

func init() {
	rootCmd.AddCommand(tuiCmd)
}

func runTUI(cmd *cobra.Command, args []string) error {
	// Load config
	loader := config.NewLoader()
	cfg, err := loader.Load()
	if err != nil {
		return fmt.Errorf("loading config: %w", err)
	}

	// Initialize dependencies
	gitClient := git.NewClient()
	stateStore := state.NewStore(cfg.AIWorkingDir)
	discovery := repo.NewDiscovery(cfg, gitClient)
	wtManager := worktree.NewManager(cfg, gitClient, stateStore)
	statusComputer := status.NewComputer(gitClient, cfg.StatusCacheTTL)

	// Create TUI model
	model := tui.New(discovery, wtManager, statusComputer)

	// Run TUI
	p := tea.NewProgram(model, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		return fmt.Errorf("running TUI: %w", err)
	}

	return nil
}
```

**Validation:**
- [ ] TUI launches without errors
- [ ] Can navigate between panels with Tab
- [ ] Repo list loads asynchronously
- [ ] Selecting repo loads worktrees
- [ ] Status badges display correctly
- [ ] Keyboard shortcuts work as expected

---

### Task 2.6: TUI Actions (6-8 hours)

**Objective:** Implement TUI actions for create, open, delete, refresh

**Steps:**

1. **Implement create action:**
```go
// internal/tui/actions.go
package tui

import (
	"fmt"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/bubbles/textinput"
)

func (m Model) handleNew() (tea.Model, tea.Cmd) {
	if m.selectedRepo == nil {
		return m, showErrorCmd("Select a repository first")
	}

	// Show input prompt for branch name
	m.inputMode = InputModeCreate
	m.textInput = textinput.New()
	m.textInput.Placeholder = "feature/my-branch"
	m.textInput.Focus()

	return m, nil
}

func (m Model) handleCreateSubmit(branchName string) (tea.Model, tea.Cmd) {
	if m.selectedRepo == nil {
		return m, nil
	}

	return m, createWorktreeCmd(m.wtManager, m.selectedRepo, branchName)
}

func createWorktreeCmd(manager *worktree.Manager, repo *repo.Repo, branch string) tea.Cmd {
	return func() tea.Msg {
		opts := worktree.CreateOptions{
			Branch:     branch,
			BaseBranch: repo.DefaultBranch,
		}

		wt, err := manager.Create(repo, opts)
		if err != nil {
			return errorMsg{err}
		}

		return worktreeCreatedMsg{worktree: wt}
	}
}

type worktreeCreatedMsg struct {
	worktree *worktree.Worktree
}
```

2. **Implement open action:**
```go
func (m Model) handleOpen() (tea.Model, tea.Cmd) {
	if m.selectedWT == nil {
		return m, showErrorCmd("Select a worktree first")
	}

	return m, openWorktreeCmd(m.tmuxClient, m.selectedWT, m.cfg)
}

func openWorktreeCmd(client *tmux.Client, wt *worktree.Worktree, cfg *config.Config) tea.Cmd {
	return func() tea.Msg {
		sessionName := fmt.Sprintf("%s--wt--%s", wt.Repo.Name, wt.Slug)

		// Load layout
		layout, err := tmux.LoadLayout(cfg.TmuxLayoutScript)
		if err != nil {
			layout = tmux.DefaultLayout()
		}

		// Create or attach
		err = client.CreateOrAttachWithLayout(sessionName, wt.Path, layout)
		if err != nil {
			return errorMsg{err}
		}

		return worktreeOpenedMsg{worktree: wt}
	}
}

type worktreeOpenedMsg struct {
	worktree *worktree.Worktree
}
```

3. **Implement delete action with confirmation:**
```go
func (m Model) handleDelete() (tea.Model, tea.Cmd) {
	if m.selectedWT == nil {
		return m, showErrorCmd("Select a worktree first")
	}

	// Run safety check first
	return m, checkRemovalSafetyCmd(m.safetyChecker, m.selectedWT)
}

func (m Model) handleDeleteConfirmed() (tea.Model, tea.Cmd) {
	if m.selectedWT == nil {
		return m, nil
	}

	return m, removeWorktreeCmd(m.wtManager, m.selectedWT, m.confirmForce)
}

func checkRemovalSafetyCmd(checker *safety.Checker, wt *worktree.Worktree) tea.Cmd {
	return func() tea.Msg {
		result, err := checker.CheckRemoval(wt)
		if err != nil {
			return errorMsg{err}
		}
		return removalSafetyCheckedMsg{result: result, worktree: wt}
	}
}

func removeWorktreeCmd(manager *worktree.Manager, wt *worktree.Worktree, force bool) tea.Cmd {
	return func() tea.Msg {
		err := manager.Remove(wt, force)
		if err != nil {
			return errorMsg{err}
		}
		return worktreeRemovedMsg{worktree: wt}
	}
}

type removalSafetyCheckedMsg struct {
	result   *safety.CheckResult
	worktree *worktree.Worktree
}

type worktreeRemovedMsg struct {
	worktree *worktree.Worktree
}
```

4. **Add confirmation dialog:**
```go
// internal/tui/dialog.go
package tui

import (
	"github.com/charmbracelet/lipgloss"
)

type Dialog struct {
	title   string
	message string
	buttons []string
	selected int
}

func (d Dialog) View(width, height int) string {
	titleStyle := lipgloss.NewStyle().
		Bold(true).
		Foreground(lipgloss.Color("63")).
		Padding(1, 2)

	messageStyle := lipgloss.NewStyle().
		Foreground(lipgloss.Color("252")).
		Padding(1, 2)

	buttonStyle := lipgloss.NewStyle().
		Foreground(lipgloss.Color("240")).
		Padding(0, 2).
		Border(lipgloss.RoundedBorder())

	selectedButtonStyle := buttonStyle.Copy().
		Foreground(lipgloss.Color("15")).
		BorderForeground(lipgloss.Color("69"))

	// Render buttons
	var buttons []string
	for i, btn := range d.buttons {
		style := buttonStyle
		if i == d.selected {
			style = selectedButtonStyle
		}
		buttons = append(buttons, style.Render(btn))
	}

	buttonsRow := lipgloss.JoinHorizontal(lipgloss.Center, buttons...)

	content := lipgloss.JoinVertical(lipgloss.Center,
		titleStyle.Render(d.title),
		messageStyle.Render(d.message),
		"",
		buttonsRow,
	)

	// Center in screen
	boxStyle := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("63")).
		Width(width/2).
		Height(height/3).
		AlignHorizontal(lipgloss.Center).
		AlignVertical(lipgloss.Center)

	return boxStyle.Render(content)
}

func showConfirmDialog(title, message string) Dialog {
	return Dialog{
		title:   title,
		message: message,
		buttons: []string{"Cancel", "Confirm"},
		selected: 0,
	}
}
```

5. **Handle dialog interactions:**
```go
func (m Model) updateDialog(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "left", "h":
		if m.dialog.selected > 0 {
			m.dialog.selected--
		}
		return m, nil

	case "right", "l":
		if m.dialog.selected < len(m.dialog.buttons)-1 {
			m.dialog.selected++
		}
		return m, nil

	case "enter":
		if m.dialog.selected == 1 {
			// Confirmed
			switch m.dialogType {
			case DialogTypeDelete:
				m.showDialog = false
				return m.handleDeleteConfirmed()
			}
		}
		// Cancelled or other action
		m.showDialog = false
		return m, nil

	case "esc":
		m.showDialog = false
		return m, nil
	}

	return m, nil
}
```

**Validation:**
- [ ] Can create worktrees via TUI
- [ ] Can open worktrees (launches tmux)
- [ ] Delete shows safety check results
- [ ] Confirmation dialog works correctly
- [ ] Actions update the UI appropriately

---

### Task 2.7: Integration and Polish (4-6 hours)

**Objective:** Integrate all Phase 2 features and polish the UX

**Steps:**

1. **Update list command with status:**
```go
// cmd/list.go enhancements
func runList(cmd *cobra.Command, args []string) error {
	// ... existing setup ...

	// Status computer
	statusComputer := status.NewComputer(gitClient, cfg.StatusCacheTTL)

	// List worktrees
	worktrees, err := wtManager.List(r)
	if err != nil {
		return fmt.Errorf("listing worktrees: %w", err)
	}

	// Compute status in parallel if requested
	var statuses map[string]*status.Status
	if listFlags.status {
		statuses = statusComputer.ComputeAll(worktrees)
	}

	// Display
	if listFlags.json {
		return outputJSON(worktrees, statuses)
	}

	fmt.Printf("\n%s worktrees:\n\n", r.Name)
	for _, wt := range worktrees {
		fmt.Printf("  • %s", wt.Branch)

		if listFlags.status {
			if st, ok := statuses[wt.Path]; ok {
				badges := st.GetBadges()
				for _, badge := range badges {
					fmt.Printf(" %s", badge.Symbol)
				}
			}
		}

		fmt.Printf("\n    Slug: %s\n", wt.Slug)
		if listFlags.verbose {
			fmt.Printf("    Path: %s\n", wt.Path)
			fmt.Printf("    Created: %s\n", wt.CreatedAt.Format("2006-01-02 15:04"))
		}
		fmt.Println()
	}

	return nil
}
```

2. **Add remove safety integration:**
```go
// cmd/remove.go - already covered in Task 2.1
```

3. **Create example layout files:**
```json
// ~/.config/swarm/layouts/default.json
{
  "windows": [
    {
      "name": "editor",
      "command": "nvim .",
      "panes": []
    },
    {
      "name": "shell",
      "command": "",
      "panes": []
    },
    {
      "name": "tests",
      "command": "make test-watch",
      "panes": [
        {
          "command": "make watch",
          "direction": "vertical",
          "size": 50
        }
      ]
    }
  ]
}
```

```bash
# ~/.config/swarm/layouts/rails.sh
#!/bin/bash
# Custom layout for Rails projects

cat <<'EOF'
{
  "windows": [
    {
      "name": "editor",
      "command": "nvim .",
      "panes": []
    },
    {
      "name": "server",
      "command": "rails server",
      "panes": [
        {
          "command": "tail -f log/development.log",
          "direction": "horizontal",
          "size": 30
        }
      ]
    },
    {
      "name": "console",
      "command": "rails console",
      "panes": []
    },
    {
      "name": "tests",
      "command": "bundle exec rspec --format documentation",
      "panes": []
    }
  ]
}
EOF
```

4. **Update README with Phase 2 features:**
```markdown
## Phase 2 Features

### Interactive TUI
```bash
swarm tui
# Interactive interface with:
# - Three-panel layout (repos, worktrees, details)
# - Real-time status badges
# - Keyboard-driven navigation
# - Create/open/delete actions
```

### Safety Checks
```bash
swarm remove repo branch
# Automatically checks:
# - Uncommitted changes (blocks removal)
# - Unpushed commits (warns)
# - Branch merge status (warns)
#
# Use --force to bypass
```

### Enhanced Tmux
```bash
# Custom layouts
swarm open repo branch
# Uses layout from config or default

# List sessions
swarm sessions
# Shows all active swarm sessions
```

### Orphan Cleanup
```bash
# Clean stale state
swarm prune repo
swarm prune --all

# Dry run
swarm prune --all --dry-run
```
```

5. **Write comprehensive tests:**
```bash
# Create integration test suite
mkdir -p test/integration/phase2

# Test safety checks
test/integration/phase2/test_safety.sh

# Test TUI (manual for now)
test/integration/phase2/test_tui_manual.md

# Test layouts
test/integration/phase2/test_layouts.sh

# Test orphan detection
test/integration/phase2/test_orphans.sh
```

**Validation:**
- [ ] All Phase 2 commands work end-to-end
- [ ] Safety checks prevent data loss
- [ ] TUI is responsive and intuitive
- [ ] Custom layouts load correctly
- [ ] Orphan detection works reliably
- [ ] Documentation is complete

---

## Phase 2 Completion Checklist

### Features
- [ ] Safety checker module implemented
- [ ] Status computation with caching working
- [ ] Orphan detection and cleanup functional
- [ ] Enhanced tmux with layouts
- [ ] TUI launches and works
- [ ] TUI actions (create, open, delete) functional

### Commands
- [ ] `swarm tui` - Interactive UI
- [ ] `swarm sessions` - List sessions
- [ ] `swarm prune` - Clean orphans
- [ ] `swarm remove` - With safety checks

### Quality
- [ ] All unit tests pass
- [ ] Integration tests pass
- [ ] Manual testing completed
- [ ] No regressions from Phase 1
- [ ] Performance acceptable (<2s for common ops)

### Documentation
- [ ] README updated with Phase 2 features
- [ ] Example layout files provided
- [ ] ADRs updated if needed
- [ ] User guide includes new commands

---

## Testing Strategy

### Unit Tests
```bash
# Safety checker
go test ./internal/safety/... -v

# Status computer
go test ./internal/status/... -v

# Orphan detector
go test ./internal/worktree/... -run TestOrphan -v

# Layout system
go test ./internal/tmux/... -run TestLayout -v
```

### Integration Tests
```bash
# TUI (manual)
go build -o swarm ./cmd/swarm
./swarm tui

# Safety checks
./test/integration/phase2/test_safety.sh

# Layouts
./test/integration/phase2/test_layouts.sh
```

### Manual Test Plan

**TUI Testing:**
1. Launch TUI: `swarm tui`
2. Navigate repos with arrow keys
3. Press Enter to select repo
4. Navigate worktrees
5. Press 'd' to delete (test safety check)
6. Press 'n' to create new
7. Press 'o' to open
8. Press 'r' to refresh
9. Press 'q' to quit

**Safety Testing:**
1. Create worktree with changes
2. Try to remove without --force (should block)
3. Remove with --force (should succeed)
4. Create worktree with unpushed commits
5. Try to remove (should warn but allow)

**Layout Testing:**
1. Create custom layout JSON
2. Set `tmux_layout_script` in config
3. Open worktree
4. Verify tmux layout matches spec

---

## Troubleshooting

### Common Issues

**TUI doesn't render:**
- Check terminal supports ANSI colors
- Try `export TERM=xterm-256color`
- Ensure terminal is at least 80x24

**Safety checks too strict:**
- Use `--force` for legitimate removals
- Check git status manually
- Consider adjusting config

**Layouts not applying:**
- Verify JSON syntax
- Check script is executable
- Test script manually first
- Check tmux version (3.0+)

**Status computation slow:**
- Increase cache TTL in config
- Reduce number of worktrees
- Check git performance

---

## Next Steps

After Phase 2 completion, move to [Phase 3: Refinement & Polish](PHASE-3-REFINEMENT.md):
- `revive` command
- `rename` command
- Performance optimization
- Shell completions
- User documentation
- Polish and bug fixes

---

## Summary

Phase 2 transforms Swarm from a basic CLI into a polished, production-ready tool with:
- **Safety:** Comprehensive checks prevent data loss
- **Usability:** Interactive TUI for discovery and management
- **Flexibility:** Custom tmux layouts
- **Reliability:** Orphan detection and cleanup
- **Performance:** Status caching and parallel computation

The tool is now suitable for daily use by development teams managing multiple worktrees across many repositories.
