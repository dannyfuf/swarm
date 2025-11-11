package git

import (
	"fmt"
	"os/exec"
	"strings"
)

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
		if len(output) == 0 || strings.Contains(string(output), "unknown revision") {
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
