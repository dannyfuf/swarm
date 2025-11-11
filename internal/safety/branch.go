package safety

import (
	"fmt"
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
	output += "Branch status:\n"
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
