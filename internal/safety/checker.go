package safety

import (
	"fmt"
	"os"
	"time"

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

	// Check if worktree directory exists
	if _, err := os.Stat(wt.Path); os.IsNotExist(err) {
		// Dangling worktree - directory doesn't exist, safe to remove
		return result, nil
	}

	// Check 1: Uncommitted changes
	status, err := c.git.Status(wt.Path)
	if err != nil {
		// Cannot verify worktree safety - path exists but git status failed
		return nil, fmt.Errorf("cannot check worktree status at %s: %w", wt.Path, err)
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
	// Note: We need the repo path and default branch - for now we skip this
	// This can be enhanced when we have full repo context

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
