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
	output, err := cmd.CombinedOutput()
	if err != nil {
		outputStr := string(output)

		// Exit code 1 means branch doesn't exist (this is expected)
		if exitErr, ok := err.(*exec.ExitError); ok {
			if exitErr.ExitCode() == 1 {
				return false, nil
			}
			// Exit code 128 could be "not a git repo" or just "ref not found"
			if exitErr.ExitCode() == 128 {
				// If it's truly not a git repo, that's an error
				if strings.Contains(outputStr, "not a git repository") {
					return false, fmt.Errorf("checking branch existence: %w", err)
				}
				// Otherwise, ref not found means branch doesn't exist
				if strings.Contains(outputStr, "not a valid ref") ||
					strings.Contains(outputStr, "not found") {
					return false, nil
				}
			}
		}
		return false, fmt.Errorf("checking branch existence: %w\nOutput: %s", err, output)
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
