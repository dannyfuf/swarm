package worktree

import "time"

// Worktree represents a Git worktree
type Worktree struct {
	Slug         string
	Branch       string
	Path         string
	RepoName     string
	CreatedAt    time.Time
	LastOpenedAt time.Time
	TmuxSession  string
	IsOrphaned   bool // True if directory is missing but still in state
}

// CreateOptions for creating a worktree
type CreateOptions struct {
	Branch     string
	BaseBranch string
	NewBranch  bool
}
