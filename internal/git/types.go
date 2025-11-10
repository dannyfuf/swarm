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
