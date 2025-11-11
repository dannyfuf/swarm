# Phase 3: Branch Lifecycle Management

**Status:** ✅ COMPLETED

**Goal:** Implement intelligent branch lifecycle management that gives users clear control over branch creation and deletion during worktree operations.

**Duration Estimate:** 1-2 days for junior developer

**Prerequisites:** Phase 1 complete - basic CLI working, safety checks in place

**Deliverables:**
- ✅ Branch existence detection and handling
- ✅ Interactive prompts for branch decisions
- ✅ Automation flags for scripting
- ✅ Enhanced safety checks for branch operations
- ✅ Clear user messaging about consequences

---

## Overview

Phase 3 addresses critical gaps in branch lifecycle management. Currently, users cannot:
- Create worktrees with existing branches (hard failure)
- Decide whether to keep or delete branches when removing worktrees
- Understand the consequences of their choices

This phase adds intelligent prompts and automation-friendly flags to give users full control while maintaining safety.

### Key Improvements

```
Current State                    Phase 3 (Enhanced)
├─ Create fails on existing      ├─ Detects existing branches
│  branch                        ├─ Offers: use|recreate|cancel
├─ Remove never touches          ├─ Prompts for branch handling
│  branches                      ├─ Shows commit/merge status
└─ No branch information         └─ Clear consequences shown
```

### Problem Statement

**Issue 1: Creating worktree with existing branch**
```bash
$ swarm create repo feat/test
Error: fatal: a branch named 'feat/test' already exists
# User has no way to checkout existing branch or choose to recreate
```

**Issue 2: Removing worktrees leaves orphaned branches**
```bash
$ swarm remove repo feat/test
✓ Removed worktree
# Branch remains with potential unpushed work
# No way to clean up or preserve intentionally
```

---

## Architecture

### New Modules

```
internal/
├── git/
│   └── branch.go          # Branch operations (detect, delete, info)
├── prompt/
│   └── prompt.go          # User interaction (choice, confirm)
└── safety/
    └── branch.go          # Branch deletion safety checks

cmd/
├── create.go              # Enhanced with branch handling
└── remove.go              # Enhanced with branch cleanup
```

### Design Decision: Flags + Prompts

**Approach:** Provide flags for automation, fallback to prompts for interactive use

**Rationale:**
1. **Scriptable**: Flags enable CI/CD and automation
2. **User-friendly**: Prompts guide interactive users
3. **Simple**: No complex TUI infrastructure needed yet
4. **Extensible**: Can add TUI layer later

**Alternatives considered:**
- **CLI prompts only**: Not scriptable, poor for automation
- **TUI integration**: Complex, delays value, Phase 2 already has TUI
- **Smart defaults**: Dangerous without user visibility

---

## Task Breakdown

### Task 3.1: Branch Detection Module (1-2 hours)

**Objective:** Implement git operations for branch lifecycle management

**Module:** `internal/git/branch.go`

#### Implementation

```go
package git

import (
	"fmt"
	"os/exec"
	"strings"
)

// BranchInfo contains information about a branch
type BranchInfo struct {
	Name        string
	Exists      bool
	HasCommits  bool
	CommitCount int
	IsMerged    bool
	Upstream    string
	LastCommit  *Commit
}

// BranchExists checks if a local branch exists
func (c *Client) BranchExists(repoPath, branch string) (bool, error) {
	cmd := exec.Command("git", "-C", repoPath, "show-ref", "--verify",
		fmt.Sprintf("refs/heads/%s", branch))
	err := cmd.Run()
	if err != nil {
		// Exit code 1 means branch doesn't exist
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return false, nil
		}
		return false, fmt.Errorf("checking branch existence: %w", err)
	}
	return true, nil
}

// GetBranchInfo returns detailed information about a branch
func (c *Client) GetBranchInfo(repoPath, branch string) (*BranchInfo, error) {
	info := &BranchInfo{
		Name: branch,
	}

	// Check existence
	exists, err := c.BranchExists(repoPath, branch)
	if err != nil {
		return nil, err
	}
	info.Exists = exists

	if !exists {
		return info, nil
	}

	// Get commit count
	cmd := exec.Command("git", "-C", repoPath, "rev-list", "--count", branch)
	output, err := cmd.Output()
	if err == nil {
		fmt.Sscanf(strings.TrimSpace(string(output)), "%d", &info.CommitCount)
		info.HasCommits = info.CommitCount > 0
	}

	// Check if merged (compare with default branch)
	defaultBranch, _ := c.DefaultBranch(repoPath)
	if defaultBranch != "" {
		merged, _ := c.IsMerged(repoPath, branch, defaultBranch)
		info.IsMerged = merged
	}

	// Get last commit
	cmd = exec.Command("git", "-C", repoPath, "log", "-1",
		"--pretty=format:%H|%s|%an|%ad", "--date=iso", branch)
	output, err = cmd.Output()
	if err == nil && len(output) > 0 {
		commits, _ := c.parser.ParseCommits(string(output))
		if len(commits) > 0 {
			info.LastCommit = &commits[0]
		}
	}

	// Get upstream
	cmd = exec.Command("git", "-C", repoPath, "rev-parse", "--abbrev-ref",
		fmt.Sprintf("%s@{upstream}", branch))
	output, err = cmd.Output()
	if err == nil {
		info.Upstream = strings.TrimSpace(string(output))
	}

	return info, nil
}

// DeleteBranch removes a local branch
func (c *Client) DeleteBranch(repoPath, branch string, force bool) error {
	flag := "-d" // Safe delete (must be merged)
	if force {
		flag = "-D" // Force delete
	}

	cmd := exec.Command("git", "-C", repoPath, "branch", flag, branch)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("deleting branch: %w\nOutput: %s", err, output)
	}
	return nil
}
```

#### Tests

```go
// internal/git/branch_test.go
package git

import (
	"os"
	"path/filepath"
	"testing"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBranchExists(t *testing.T) {
	// Setup test repo
	repoPath := setupTestRepo(t)
	defer os.RemoveAll(repoPath)

	client := NewClient()

	// Create test branch
	createBranch(t, repoPath, "test-branch")

	exists, err := client.BranchExists(repoPath, "test-branch")
	require.NoError(t, err)
	assert.True(t, exists)

	exists, err = client.BranchExists(repoPath, "nonexistent")
	require.NoError(t, err)
	assert.False(t, exists)
}

func TestGetBranchInfo(t *testing.T) {
	repoPath := setupTestRepo(t)
	defer os.RemoveAll(repoPath)

	client := NewClient()

	// Create branch with commits
	createBranch(t, repoPath, "feature")
	makeCommit(t, repoPath, "feature", "test.txt", "content")

	info, err := client.GetBranchInfo(repoPath, "feature")
	require.NoError(t, err)
	assert.True(t, info.Exists)
	assert.True(t, info.HasCommits)
	assert.Greater(t, info.CommitCount, 0)
	assert.NotNil(t, info.LastCommit)
}

func TestDeleteBranch(t *testing.T) {
	repoPath := setupTestRepo(t)
	defer os.RemoveAll(repoPath)

	client := NewClient()

	createBranch(t, repoPath, "to-delete")

	err := client.DeleteBranch(repoPath, "to-delete", false)
	require.NoError(t, err)

	exists, _ := client.BranchExists(repoPath, "to-delete")
	assert.False(t, exists)
}
```

**Validation:**
- [ ] BranchExists correctly detects existing branches
- [ ] GetBranchInfo returns accurate commit counts
- [ ] GetBranchInfo detects merge status
- [ ] DeleteBranch removes branches safely
- [ ] DeleteBranch with force removes unmerged branches

---

### Task 3.2: User Prompt Module (1 hour)

**Objective:** Create reusable prompt utilities for user interaction

**Module:** `internal/prompt/prompt.go`

#### Implementation

```go
package prompt

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Choice presents numbered options and returns selection
func Choice(question string, options []string, defaultChoice int) (int, error) {
	fmt.Println(question)
	fmt.Println()

	for i, opt := range options {
		fmt.Printf("  %d. %s\n", i+1, opt)
	}
	fmt.Println()

	fmt.Printf("Choice [%d]: ", defaultChoice)

	reader := bufio.NewReader(os.Stdin)
	input, err := reader.ReadString('\n')
	if err != nil {
		return 0, fmt.Errorf("reading input: %w", err)
	}

	input = strings.TrimSpace(input)

	// Empty input uses default
	if input == "" {
		return defaultChoice - 1, nil
	}

	// Parse choice
	choice, err := strconv.Atoi(input)
	if err != nil || choice < 1 || choice > len(options) {
		return 0, fmt.Errorf("invalid choice: must be 1-%d", len(options))
	}

	return choice - 1, nil
}

// Confirm asks a yes/no question
func Confirm(question string, defaultYes bool) (bool, error) {
	prompt := "[y/N]"
	if defaultYes {
		prompt = "[Y/n]"
	}

	fmt.Printf("%s %s: ", question, prompt)

	reader := bufio.NewReader(os.Stdin)
	input, err := reader.ReadString('\n')
	if err != nil {
		return false, fmt.Errorf("reading input: %w", err)
	}

	input = strings.ToLower(strings.TrimSpace(input))

	if input == "" {
		return defaultYes, nil
	}

	return input == "y" || input == "yes", nil
}

// IsInteractive checks if we're in an interactive terminal
func IsInteractive() bool {
	fileInfo, _ := os.Stdin.Stat()
	return (fileInfo.Mode() & os.ModeCharDevice) != 0
}
```

#### Tests

```go
// internal/prompt/prompt_test.go
package prompt

import (
	"strings"
	"testing"
	"github.com/stretchr/testify/assert"
)

func TestChoice(t *testing.T) {
	// Test with mock stdin
	tests := []struct {
		name     string
		input    string
		options  []string
		want     int
		wantErr  bool
	}{
		{
			name:    "valid choice",
			input:   "2\n",
			options: []string{"opt1", "opt2", "opt3"},
			want:    1,
		},
		{
			name:    "default choice",
			input:   "\n",
			options: []string{"opt1", "opt2"},
			want:    0, // default is 1, returns 0-indexed
		},
		{
			name:    "invalid choice",
			input:   "5\n",
			options: []string{"opt1", "opt2"},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Mock stdin
			oldStdin := os.Stdin
			r, w, _ := os.Pipe()
			os.Stdin = r

			go func() {
				w.Write([]byte(tt.input))
				w.Close()
			}()

			got, err := Choice("Test?", tt.options, 1)

			os.Stdin = oldStdin

			if tt.wantErr {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
				assert.Equal(t, tt.want, got)
			}
		})
	}
}
```

**Validation:**
- [ ] Choice displays options correctly
- [ ] Choice accepts valid numeric input
- [ ] Choice uses default on empty input
- [ ] Choice rejects invalid input
- [ ] Confirm handles y/n/default correctly
- [ ] IsInteractive detects TTY correctly

---

### Task 3.3: Branch Safety Checks (1 hour)

**Objective:** Extend safety checks to cover branch deletion

**Module:** `internal/safety/branch.go`

#### Implementation

```go
package safety

import (
	"fmt"
	"github.com/microsoft/amplifier/swarm/internal/git"
)

// BranchSafetyResult represents branch deletion safety
type BranchSafetyResult struct {
	Safe          bool
	Warnings      []string
	Blockers      []string
	CommitCount   int
	UnpushedCount int
	IsMerged      bool
}

// CheckBranchDeletion validates if branch can be safely deleted
func (c *Checker) CheckBranchDeletion(
	repoPath string,
	branch string,
) (*BranchSafetyResult, error) {
	result := &BranchSafetyResult{
		Safe: true,
	}

	// Get branch info
	info, err := c.git.GetBranchInfo(repoPath, branch)
	if err != nil {
		return nil, fmt.Errorf("getting branch info: %w", err)
	}

	if !info.Exists {
		return result, nil // Branch doesn't exist, safe to "delete"
	}

	result.CommitCount = info.CommitCount
	result.IsMerged = info.IsMerged

	// Check for commits
	if info.CommitCount > 0 {
		if info.IsMerged {
			result.Warnings = append(result.Warnings,
				fmt.Sprintf("Branch has %d commit(s) but is merged into main",
					info.CommitCount))
		} else {
			result.Warnings = append(result.Warnings,
				fmt.Sprintf("Branch has %d unmerged commit(s)", info.CommitCount))
		}
	}

	// Check for unpushed commits
	if info.Upstream != "" {
		unpushed, err := c.git.UnpushedCommits(repoPath, branch)
		if err == nil && len(unpushed) > 0 {
			result.UnpushedCount = len(unpushed)
			result.Warnings = append(result.Warnings,
				fmt.Sprintf("Branch has %d unpushed commit(s)", len(unpushed)))
		}
	}

	return result, nil
}

// FormatBranchSafetyResult returns human-readable output
func FormatBranchSafetyResult(result *BranchSafetyResult) string {
	if result.CommitCount == 0 {
		return "Branch has no commits (safe to delete)"
	}

	var output string
	output += fmt.Sprintf("Branch status:\n")
	output += fmt.Sprintf("  • %d commit(s)\n", result.CommitCount)

	if result.UnpushedCount > 0 {
		output += fmt.Sprintf("  • %d unpushed commit(s) ⚠️\n", result.UnpushedCount)
	}

	if result.IsMerged {
		output += "  • Merged into main ✓\n"
	} else {
		output += "  • Not merged ⚠️\n"
	}

	return output
}
```

**Validation:**
- [ ] Detects commits on branch
- [ ] Detects unpushed commits
- [ ] Detects merge status
- [ ] Provides clear warnings
- [ ] Format is user-friendly

---

### Task 3.4: Enhanced Create Command (2-3 hours)

**Objective:** Handle existing branches intelligently

**Module:** `cmd/create.go`

#### Changes

```go
var createFlags struct {
	from     string
	onExists string // New flag: prompt|use|recreate|fail
}

func init() {
	rootCmd.AddCommand(createCmd)
	createCmd.Flags().StringVar(&createFlags.from, "from", "",
		"Base branch to create from (default: repo's default branch)")
	createCmd.Flags().StringVar(&createFlags.onExists, "on-exists", "prompt",
		"Action when branch exists: prompt|use|recreate|fail")
}

func runCreate(cmd *cobra.Command, args []string) error {
	repoName := args[0]
	branch := args[1]

	// ... existing setup code ...

	// Check if branch already exists
	branchInfo, err := gitClient.GetBranchInfo(r.Path, branch)
	if err != nil {
		return fmt.Errorf("checking branch: %w", err)
	}

	var newBranch bool
	var useExisting bool

	if branchInfo.Exists {
		// Branch exists - handle based on flag/prompt
		action := createFlags.onExists

		if action == "prompt" && !prompt.IsInteractive() {
			action = "fail" // Non-interactive defaults to fail
		}

		switch action {
		case "use":
			useExisting = true
			newBranch = false
			fmt.Printf("Using existing branch '%s'\n", branch)

		case "recreate":
			// Delete and recreate
			fmt.Printf("⚠️  Deleting existing branch '%s'\n", branch)

			// Show branch info
			if branchInfo.HasCommits {
				fmt.Println(formatBranchInfo(branchInfo))
				if !confirmDestructive() {
					return fmt.Errorf("cancelled by user")
				}
			}

			if err := gitClient.DeleteBranch(r.Path, branch, true); err != nil {
				return fmt.Errorf("deleting existing branch: %w", err)
			}
			newBranch = true
			useExisting = false

		case "fail":
			return fmt.Errorf("branch '%s' already exists (use --on-exists to handle)", branch)

		case "prompt":
			// Show branch info
			fmt.Printf("\n⚠️  Branch '%s' already exists\n\n", branch)
			fmt.Println(formatBranchInfo(branchInfo))

			options := []string{
				"Use existing branch (checkout existing work)",
				"Delete and recreate (⚠️  will lose commits)",
				"Cancel",
			}

			choice, err := prompt.Choice("What would you like to do?", options, 1)
			if err != nil {
				return fmt.Errorf("getting user choice: %w", err)
			}

			switch choice {
			case 0: // Use existing
				useExisting = true
				newBranch = false
			case 1: // Recreate
				if err := gitClient.DeleteBranch(r.Path, branch, true); err != nil {
					return fmt.Errorf("deleting branch: %w", err)
				}
				newBranch = true
				useExisting = false
			case 2: // Cancel
				return fmt.Errorf("cancelled by user")
			}

		default:
			return fmt.Errorf("invalid --on-exists value: %s", action)
		}
	} else {
		// Branch doesn't exist - create new
		newBranch = true
		useExisting = false
	}

	// Create worktree
	opts := worktree.CreateOptions{
		Branch:     branch,
		BaseBranch: createFlags.from,
		NewBranch:  newBranch,
	}

	if useExisting {
		// For existing branch, don't specify base branch
		opts.BaseBranch = ""
	} else if opts.BaseBranch == "" {
		opts.BaseBranch = r.DefaultBranch
	}

	wt, err := wtManager.Create(r, opts)
	if err != nil {
		return fmt.Errorf("creating worktree: %w", err)
	}

	fmt.Printf("✓ Created worktree for %s/%s\n", repoName, branch)
	fmt.Printf("  Path: %s\n", wt.Path)
	fmt.Printf("  Slug: %s\n", wt.Slug)

	// ... rest of existing tmux code ...

	return nil
}

func formatBranchInfo(info *git.BranchInfo) string {
	var output string
	output += "  Branch info:\n"

	if info.CommitCount > 0 {
		output += fmt.Sprintf("    • %d commit(s)\n", info.CommitCount)

		if info.LastCommit != nil {
			output += fmt.Sprintf("    • Last commit: %s\n",
				info.LastCommit.Date.Format("2006-01-02"))
		}
	} else {
		output += "    • No commits\n"
	}

	if info.IsMerged {
		output += "    • Merged into main\n"
	} else {
		output += "    • Not merged\n"
	}

	return output
}

func confirmDestructive() bool {
	confirmed, err := prompt.Confirm("Are you sure?", false)
	if err != nil {
		return false
	}
	return confirmed
}
```

#### Example Usage

```bash
# Interactive mode - prompts user
$ swarm create repo feat/existing
⚠️  Branch 'feat/existing' already exists

  Branch info:
    • 3 commits
    • Last commit: 2025-01-08
    • Not merged

  What would you like to do?
    1. Use existing branch (checkout existing work)
    2. Delete and recreate (⚠️  will lose commits)
    3. Cancel

  Choice [1]: 1
✓ Created worktree for repo/feat/existing

# Automated mode - use existing
$ swarm create repo feat/existing --on-exists=use
Using existing branch 'feat/existing'
✓ Created worktree for repo/feat/existing

# Automated mode - recreate
$ swarm create repo feat/test --on-exists=recreate
⚠️  Deleting existing branch 'feat/test'
✓ Created worktree for repo/feat/test

# Automated mode - fail
$ swarm create repo feat/test --on-exists=fail
Error: branch 'feat/test' already exists (use --on-exists to handle)
```

**Validation:**
- [ ] Detects existing branches before creation
- [ ] Prompts user with clear options in interactive mode
- [ ] Respects --on-exists flag in automation
- [ ] Shows commit info before destructive actions
- [ ] Can checkout existing branch
- [ ] Can delete and recreate branch
- [ ] Handles non-interactive mode safely

---

### Task 3.5: Enhanced Remove Command (2-3 hours)

**Objective:** Add branch cleanup options to remove command

**Module:** `cmd/remove.go`

#### Changes

```go
var removeFlags struct {
	force  bool
	branch string // New flag: prompt|keep|delete
}

func init() {
	rootCmd.AddCommand(removeCmd)
	removeCmd.Flags().BoolVarP(&removeFlags.force, "force", "f", false,
		"Force removal even if there are uncommitted changes")
	removeCmd.Flags().StringVar(&removeFlags.branch, "branch", "prompt",
		"Branch handling: prompt|keep|delete")
}

func runRemove(cmd *cobra.Command, args []string) error {
	repoName := args[0]
	branch := args[1]

	// ... existing setup and worktree finding code ...

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

	// Remove worktree
	if err := wtManager.Remove(targetWt, removeFlags.force); err != nil {
		return fmt.Errorf("removing worktree: %w", err)
	}

	fmt.Printf("✓ Removed worktree for %s/%s\n", repoName, branch)

	// Handle branch deletion
	if err := handleBranchCleanup(gitClient, r.Path, branch); err != nil {
		fmt.Printf("Warning: %v\n", err)
		// Don't fail the command - worktree is already removed
	}

	return nil
}

func handleBranchCleanup(gitClient *git.Client, repoPath, branch string) error {
	action := removeFlags.branch

	if action == "prompt" && !prompt.IsInteractive() {
		action = "keep" // Non-interactive defaults to keep
	}

	switch action {
	case "keep":
		// Do nothing, branch remains
		fmt.Printf("  Branch '%s' kept\n", branch)
		return nil

	case "delete":
		// Delete without prompting
		if err := deleteBranchWithCheck(gitClient, repoPath, branch); err != nil {
			return err
		}
		fmt.Printf("  ✓ Deleted branch '%s'\n", branch)
		return nil

	case "prompt":
		// Get branch info and prompt user
		branchInfo, err := gitClient.GetBranchInfo(repoPath, branch)
		if err != nil {
			return fmt.Errorf("checking branch: %w", err)
		}

		if !branchInfo.Exists {
			// Branch already deleted somehow
			return nil
		}

		// Show branch status
		fmt.Println()
		fmt.Printf("Branch '%s' status:\n", branch)
		if branchInfo.CommitCount == 0 {
			fmt.Println("  • No commits (empty branch)")
		} else {
			fmt.Printf("  • %d commit(s)\n", branchInfo.CommitCount)

			// Check unpushed
			unpushed, err := gitClient.UnpushedCommits(repoPath, branch)
			if err == nil && len(unpushed) > 0 {
				fmt.Printf("  • %d unpushed commit(s) ⚠️\n", len(unpushed))
			}

			if branchInfo.IsMerged {
				fmt.Println("  • Merged into main ✓")
			} else {
				fmt.Println("  • Not merged ⚠️")
			}
		}

		fmt.Println()

		options := []string{
			"Keep branch (preserve work for later)",
			"Delete branch",
		}

		// Suggest delete for merged branches or empty branches
		defaultChoice := 1
		if branchInfo.IsMerged || branchInfo.CommitCount == 0 {
			defaultChoice = 2
		}

		choice, err := prompt.Choice("Delete the branch?", options, defaultChoice)
		if err != nil {
			return fmt.Errorf("getting user choice: %w", err)
		}

		if choice == 1 { // Delete
			if err := deleteBranchWithCheck(gitClient, repoPath, branch); err != nil {
				return err
			}
			fmt.Printf("  ✓ Deleted branch '%s'\n", branch)
		} else {
			fmt.Printf("  Branch '%s' kept\n", branch)
		}

		return nil

	default:
		return fmt.Errorf("invalid --branch value: %s", action)
	}
}

func deleteBranchWithCheck(gitClient *git.Client, repoPath, branch string) error {
	// Try safe delete first
	err := gitClient.DeleteBranch(repoPath, branch, false)
	if err == nil {
		return nil
	}

	// If safe delete fails, it's probably unmerged
	// Ask for confirmation before force delete
	if prompt.IsInteractive() {
		fmt.Println("⚠️  Branch is not fully merged")
		confirmed, err := prompt.Confirm("Force delete anyway?", false)
		if err != nil || !confirmed {
			return fmt.Errorf("branch deletion cancelled")
		}
	}

	return gitClient.DeleteBranch(repoPath, branch, true)
}
```

#### Example Usage

```bash
# Interactive mode - prompts user
$ swarm remove repo feat/test

✓ Removed worktree for repo/feat/test

Branch 'feat/test' status:
  • 5 commits
  • 2 unpushed commits ⚠️
  • Not merged ⚠️

Delete the branch?
  1. Keep branch (preserve work for later)
  2. Delete branch

Choice [1]: 1
  Branch 'feat/test' kept

# Automated mode - keep branch
$ swarm remove repo feat/test --branch=keep
✓ Removed worktree for repo/feat/test
  Branch 'feat/test' kept

# Automated mode - delete branch
$ swarm remove repo feat/merged --branch=delete
✓ Removed worktree for repo/feat/merged
  ✓ Deleted branch 'feat/merged'

# Interactive with merged branch (suggests delete)
$ swarm remove repo feat/merged

✓ Removed worktree for repo/feat/merged

Branch 'feat/merged' status:
  • 3 commits
  • Merged into main ✓

Delete the branch?
  1. Keep branch (preserve work for later)
  2. Delete branch

Choice [2]: 2  # Defaults to delete for merged branches
  ✓ Deleted branch 'feat/merged'
```

**Validation:**
- [ ] Prompts user about branch in interactive mode
- [ ] Respects --branch flag in automation
- [ ] Shows branch status before decision
- [ ] Suggests deleting merged branches
- [ ] Suggests deleting empty branches
- [ ] Requires confirmation for unmerged branches
- [ ] Handles non-interactive mode safely

---

### Task 3.6: Integration & Testing (1-2 hours)

**Objective:** Ensure all pieces work together and add comprehensive tests

#### Integration Tests

```bash
# test/integration/phase3/test_branch_lifecycle.sh
#!/bin/bash
set -e

echo "Testing branch lifecycle management..."

# Setup
TEST_REPO="test-repo"
TEST_BRANCH="feat/test"

# Test 1: Create with new branch (existing behavior)
echo "Test 1: Create new branch"
swarm create "$TEST_REPO" "$TEST_BRANCH"
assert_worktree_exists "$TEST_REPO" "$TEST_BRANCH"
assert_branch_exists "$TEST_REPO" "$TEST_BRANCH"

# Cleanup
swarm remove "$TEST_REPO" "$TEST_BRANCH" --branch=delete --force

# Test 2: Create with existing branch (use)
echo "Test 2: Use existing branch"
git -C "$TEST_REPO" branch "$TEST_BRANCH"
echo "1" | swarm create "$TEST_REPO" "$TEST_BRANCH" # Choice: use existing
assert_worktree_exists "$TEST_REPO" "$TEST_BRANCH"

# Cleanup
swarm remove "$TEST_REPO" "$TEST_BRANCH" --branch=delete --force

# Test 3: Create with existing branch (recreate)
echo "Test 3: Recreate existing branch"
git -C "$TEST_REPO" branch "$TEST_BRANCH"
echo -e "2\ny" | swarm create "$TEST_REPO" "$TEST_BRANCH" # Choice: recreate, confirm
assert_worktree_exists "$TEST_REPO" "$TEST_BRANCH"

# Test 4: Remove and keep branch
echo "Test 4: Remove worktree, keep branch"
echo "1" | swarm remove "$TEST_REPO" "$TEST_BRANCH" --force # Choice: keep
assert_worktree_not_exists "$TEST_REPO" "$TEST_BRANCH"
assert_branch_exists "$TEST_REPO" "$TEST_BRANCH"

# Test 5: Remove and delete branch
echo "Test 5: Remove worktree and branch"
swarm create "$TEST_REPO" "$TEST_BRANCH" --on-exists=use
echo "2" | swarm remove "$TEST_REPO" "$TEST_BRANCH" --force # Choice: delete
assert_worktree_not_exists "$TEST_REPO" "$TEST_BRANCH"
assert_branch_not_exists "$TEST_REPO" "$TEST_BRANCH"

# Test 6: Automated create (--on-exists)
echo "Test 6: Automated create with --on-exists"
git -C "$TEST_REPO" branch "$TEST_BRANCH"
swarm create "$TEST_REPO" "$TEST_BRANCH" --on-exists=use
assert_worktree_exists "$TEST_REPO" "$TEST_BRANCH"

# Test 7: Automated remove (--branch)
echo "Test 7: Automated remove with --branch"
swarm remove "$TEST_REPO" "$TEST_BRANCH" --branch=delete --force
assert_worktree_not_exists "$TEST_REPO" "$TEST_BRANCH"
assert_branch_not_exists "$TEST_REPO" "$TEST_BRANCH"

echo "✓ All branch lifecycle tests passed"
```

#### Manual Testing Checklist

**Create scenarios:**
- [ ] Create with new branch (default behavior)
- [ ] Create with existing clean branch (use it)
- [ ] Create with existing branch with commits (show info)
- [ ] Create with existing branch (recreate with confirmation)
- [ ] Create with --on-exists=use (automated)
- [ ] Create with --on-exists=recreate (automated)
- [ ] Create with --on-exists=fail (automated)

**Remove scenarios:**
- [ ] Remove and keep branch (default for unpushed)
- [ ] Remove and delete branch (default for merged)
- [ ] Remove with --branch=keep (automated)
- [ ] Remove with --branch=delete (automated)
- [ ] Remove branch with unpushed commits (warn)
- [ ] Remove merged branch (suggest delete)
- [ ] Remove empty branch (suggest delete)

**Edge cases:**
- [ ] Non-interactive mode (CI/CD)
- [ ] Branch doesn't exist anymore
- [ ] Branch deleted externally between steps
- [ ] Invalid user input to prompts
- [ ] Cancelled operations

---

## Success Criteria

### Functional Requirements
- ✅ Can create worktree with existing branch (use or recreate)
- ✅ Can decide branch fate when removing worktree
- ✅ Prompts show relevant branch information
- ✅ Flags enable automation without prompts
- ✅ Safety checks prevent accidental data loss
- ✅ Clear messaging about consequences

### User Experience
- ✅ Sensible defaults (keep valuable work)
- ✅ Clear information before destructive actions
- ✅ Fast for common cases (Enter for default)
- ✅ Informative error messages
- ✅ Works in interactive and non-interactive modes

### Safety
- ✅ No accidental deletion of unpushed work
- ✅ Warnings for all destructive operations
- ✅ Confirmation required for risky actions
- ✅ Clear communication of what will happen

### Quality
- ✅ All unit tests pass
- ✅ Integration tests cover key scenarios
- ✅ Documentation updated
- ✅ No regressions in existing functionality

---

## Edge Cases & Considerations

### Edge Case: Branch deleted externally
**Scenario:** User deletes branch in another terminal while worktree exists

**Handling:**
- Worktree operations continue to work (git worktree is resilient)
- Show clear message if branch cleanup fails
- Don't block worktree removal

### Edge Case: Non-interactive mode
**Scenario:** Running in CI/CD or pipe

**Handling:**
- `--on-exists` defaults to `fail` (safe)
- `--branch` defaults to `keep` (safe)
- Never prompt in non-interactive mode
- Clear error messages about required flags

### Edge Case: Concurrent modifications
**Scenario:** Branch changes between check and action

**Handling:**
- TOCTOU (Time-of-check-time-of-use) is acceptable
- Git operations are atomic
- Show clear error if git operation fails
- User can retry with fresh info

### Edge Case: Partial failures
**Scenario:** Worktree removed but branch deletion fails

**Handling:**
- Worktree removal is primary operation (must succeed)
- Branch cleanup is secondary (can fail gracefully)
- Show warning but don't fail command
- User can manually clean up branch

---

## Future Enhancements

**Phase 4 (TUI integration):**
- Visual branch lifecycle in TUI
- Live git status preview
- Visual diff of consequences
- Keyboard shortcuts for common actions

**Phase 5 (Batch operations):**
- `swarm cleanup` - Remove all merged branches
- `swarm cleanup --dry-run` - Preview what would be deleted
- `swarm archive` - Move old worktrees/branches to archive

**Phase 6 (Smart suggestions):**
- Auto-detect branches safe to delete
- Suggest consolidating related worktrees
- Warn about very old worktrees
- Track branch lifecycle history

---

## Troubleshooting

### Common Issues

**"Branch already exists" error:**
- Solution: Use `--on-exists=use` to checkout existing branch
- Or: Use `--on-exists=recreate` to delete and recreate

**Branch not deleted after remove:**
- Expected: Default is to keep branch
- Solution: Use `--branch=delete` or respond to prompt

**Prompt not showing:**
- Check if in interactive terminal: `tty`
- Use flags for non-interactive: `--on-exists=use --branch=keep`

**Accidental branch deletion:**
- Prevention: Prompts show commit counts before delete
- Recovery: Use `git reflog` to find deleted branch commits
- Recovery: `git branch <name> <commit-hash>` to restore

---

## Documentation Updates

### README.md additions

```markdown
### Branch Lifecycle Management

Swarm gives you full control over branches during worktree operations.

#### Creating Worktrees

When a branch already exists:

```bash
# Interactive: prompts for action
swarm create repo feat/existing

# Automated: use existing branch
swarm create repo feat/existing --on-exists=use

# Automated: delete and recreate
swarm create repo feat/existing --on-exists=recreate

# Automated: fail if exists
swarm create repo feat/existing --on-exists=fail
```

#### Removing Worktrees

Control what happens to branches:

```bash
# Interactive: prompts for decision
swarm remove repo feat/test

# Automated: keep branch
swarm remove repo feat/test --branch=keep

# Automated: delete branch
swarm remove repo feat/merged --branch=delete
```

**Smart defaults:**
- Suggests keeping branches with unpushed work
- Suggests deleting merged or empty branches
- Always shows commit info before destructive actions
```

### Man page updates

```
--on-exists=ACTION
    Action when creating worktree for existing branch.
    Values: prompt (default), use, recreate, fail

    prompt     - Ask user what to do (interactive only)
    use        - Checkout existing branch
    recreate   - Delete branch and create new one
    fail       - Exit with error

--branch=ACTION
    Action for branch when removing worktree.
    Values: prompt (default), keep, delete

    prompt     - Ask user what to do (interactive only)
    keep       - Keep branch after removing worktree
    delete     - Delete branch along with worktree
```

---

## Timeline

**Total: 8-12 hours for complete implementation**

| Task | Duration | Dependencies |
|------|----------|--------------|
| 3.1: Branch detection | 1-2h | None |
| 3.2: Prompt module | 1h | None |
| 3.3: Branch safety | 1h | 3.1 |
| 3.4: Create enhancement | 2-3h | 3.1, 3.2 |
| 3.5: Remove enhancement | 2-3h | 3.1, 3.2, 3.3 |
| 3.6: Integration & testing | 1-2h | All above |

**Milestones:**
- Day 1 AM: Core modules (3.1-3.3)
- Day 1 PM: Create command (3.4)
- Day 2 AM: Remove command (3.5)
- Day 2 PM: Testing & docs (3.6)

---

## Summary

Phase 3 closes critical gaps in branch lifecycle management:

✅ **User Control:** Clear decisions about branch fate
✅ **Automation-Friendly:** Flags enable scripting
✅ **Safe:** No accidental data loss
✅ **Clear:** Consequences shown before actions
✅ **Simple:** Minimal new concepts, familiar git semantics

The implementation follows the project's ruthless simplicity philosophy:
- Direct user prompts, no complex state machines
- Reusable prompt module
- Clear flags for automation
- Sensible defaults
- Comprehensive safety checks

After Phase 3, users have full control over their branch lifecycle while being protected from accidental data loss.
