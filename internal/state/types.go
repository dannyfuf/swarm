package state

import "time"

// SelectionState tracks current UI selection
type SelectionState struct {
	SelectedRepo     string `json:"selected_repo"`     // Currently selected repo
	SelectedWorktree string `json:"selected_worktree"` // Currently selected worktree (slug)
	SelectedWindow   string `json:"selected_window"`   // Currently selected window name
}

// State represents the entire state file
type State struct {
	Version   int                   `json:"version"`
	UpdatedAt time.Time             `json:"updated_at"`
	Repos     map[string]*RepoState `json:"repos"`
	Selection SelectionState        `json:"selection"` // NEW: Current selection state
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
	Windows      []string  `json:"windows"` // NEW: List of window names for this worktree
}
