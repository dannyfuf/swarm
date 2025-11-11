package tui

import (
	tea "github.com/charmbracelet/bubbletea"
	"github.com/microsoft/amplifier/swarm/internal/repo"
	"github.com/microsoft/amplifier/swarm/internal/worktree"
)

// Message types for async operations
type reposLoadedMsg struct {
	repos []repo.Repo
}

type worktreesLoadedMsg struct {
	worktrees []worktree.Worktree
}

type errorMsg struct {
	err error
}

// loadReposCmd loads repositories asynchronously
func loadReposCmd(discovery *repo.Discovery) tea.Cmd {
	return func() tea.Msg {
		repos, err := discovery.ScanAll()
		if err != nil {
			return errorMsg{err}
		}
		return reposLoadedMsg{repos: repos}
	}
}

// loadWorktreesCmd loads worktrees for a repository asynchronously
func loadWorktreesCmd(manager *worktree.Manager, detector *worktree.OrphanDetector, r *repo.Repo) tea.Cmd {
	return func() tea.Msg {
		worktrees, err := manager.List(r)
		if err != nil {
			return errorMsg{err}
		}

		// Detect orphans
		orphans, err := detector.DetectOrphans(r)
		if err != nil {
			// Log error but don't fail - orphan detection is non-critical
			// Just continue without marking orphans
			return worktreesLoadedMsg{worktrees: worktrees}
		}

		// Build orphan path set
		orphanPaths := make(map[string]bool)
		for _, orphan := range orphans {
			orphanPaths[orphan.Path] = true
		}

		// Mark orphaned worktrees
		for i := range worktrees {
			if orphanPaths[worktrees[i].Path] {
				worktrees[i].IsOrphaned = true
			}
		}

		return worktreesLoadedMsg{worktrees: worktrees}
	}
}

// showErrorCmd displays an error message
func showErrorCmd(message string) tea.Cmd {
	return func() tea.Msg {
		return errorMsg{err: &tuiError{message: message}}
	}
}

// tuiError is a simple error type for TUI messages
type tuiError struct {
	message string
}

func (e *tuiError) Error() string {
	return e.message
}
