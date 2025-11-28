package service

import "time"

// Repo represents a local or remote repository
type Repo struct {
	ID            string
	Name          string
	Path          string
	DefaultBranch string
	IsLocal       bool
	URL           string // For remote repos
}

// Worktree represents a git worktree
type Worktree struct {
	ID           string
	Slug         string
	Branch       string
	Path         string
	RepoName     string
	CreatedAt    time.Time
	LastOpenedAt time.Time
	IsOrphaned   bool
}

// Window represents a tmux window
type Window struct {
	ID       string
	Name     string // Full name: repo:worktree:name
	Repo     string
	Worktree string
	Label    string // Just the <name> part
	Active   bool
}

// Selection represents the current UI selection
type Selection struct {
	Repo     *Repo
	Worktree *Worktree
	Window   *Window
}
