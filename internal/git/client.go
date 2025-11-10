package git

import (
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
		return nil, fmt.Errorf("git worktree list failed: %w\nOutput: %s", err, output)
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
		return fmt.Errorf("git worktree add failed: %w\nOutput: %s", err, output)
	}

	return nil
}

func (c *Client) WorktreeRemove(repoPath, worktreePath string) error {
	cmd := exec.Command("git", "-C", repoPath, "worktree", "remove", worktreePath)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git worktree remove failed: %w\nOutput: %s", err, output)
	}

	return nil
}

func (c *Client) WorktreePrune(repoPath string) error {
	cmd := exec.Command("git", "-C", repoPath, "worktree", "prune")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git worktree prune failed: %w\nOutput: %s", err, output)
	}

	return nil
}

func (c *Client) FetchAll(repoPath string) error {
	cmd := exec.Command("git", "-C", repoPath, "fetch", "--all", "--prune")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git fetch failed: %w\nOutput: %s", err, output)
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
	cmd := exec.Command("git", "-C", repoPath, "symbolic-ref", "refs/remotes/origin/HEAD", "--short")
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
		cmd := exec.Command("git", "-C", repoPath, "rev-parse", "--verify", branch)
		if cmd.Run() == nil {
			return branch, nil
		}
	}

	return "", fmt.Errorf("could not determine default branch")
}
