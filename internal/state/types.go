package state

import "time"

// State represents the entire state file
type State struct {
	Version   int                   `json:"version"`
	UpdatedAt time.Time             `json:"updated_at"`
	Repos     map[string]*RepoState `json:"repos"`
}

// RepoState represents state for one repo
type RepoState struct {
	Path          string                    `json:"path"`
	DefaultBranch string                    `json:"default_branch"`
	LastScanned   time.Time                 `json:"last_scanned"`
	Worktrees     map[string]*WorktreeState `json:"worktrees"`
}

// WorktreeState represents persisted worktree metadata
type WorktreeState struct {
	Slug         string    `json:"slug"`
	Branch       string    `json:"branch"`
	Path         string    `json:"path"`
	CreatedAt    time.Time `json:"created_at"`
	LastOpenedAt time.Time `json:"last_opened_at"`
	TmuxSession  string    `json:"tmux_session"`
}
