package tui

import (
	"fmt"

	"github.com/charmbracelet/bubbles/list"
	"github.com/microsoft/amplifier/swarm/internal/repo"
	"github.com/microsoft/amplifier/swarm/internal/status"
	"github.com/microsoft/amplifier/swarm/internal/worktree"
)

// repoItem implements list.Item for repositories
type repoItem struct {
	repo repo.Repo
}

func (i repoItem) Title() string {
	return i.repo.Name
}

func (i repoItem) Description() string {
	return i.repo.Path
}

func (i repoItem) FilterValue() string {
	return i.repo.Name
}

// worktreeItem implements list.Item for worktrees
type worktreeItem struct {
	worktree worktree.Worktree
	status   *status.Status
}

func (i worktreeItem) Title() string {
	title := i.worktree.Branch

	// Add [GONE] badge for orphaned worktrees
	if i.worktree.IsOrphaned {
		title += " [GONE]"
	}

	if i.status != nil {
		badges := i.status.GetBadges()
		for _, badge := range badges {
			title += fmt.Sprintf(" %s", badge.Symbol)
		}
	}

	return title
}

func (i worktreeItem) Description() string {
	return i.worktree.Slug
}

func (i worktreeItem) FilterValue() string {
	return i.worktree.Branch + " " + i.worktree.Slug
}

func createRepoList(repos []repo.Repo, width, height int) list.Model {
	items := make([]list.Item, len(repos))
	for i, r := range repos {
		items[i] = repoItem{repo: r}
	}

	l := list.New(items, list.NewDefaultDelegate(), width, height)
	l.Title = "Repositories"
	l.SetShowStatusBar(false)
	l.SetFilteringEnabled(true)
	return l
}

func createWorktreeList(worktrees []worktree.Worktree, width, height int) list.Model {
	items := make([]list.Item, len(worktrees))
	for i, wt := range worktrees {
		items[i] = worktreeItem{worktree: wt}
	}

	l := list.New(items, list.NewDefaultDelegate(), width, height)
	l.Title = "Worktrees"
	l.SetShowStatusBar(false)
	l.SetFilteringEnabled(true)
	return l
}
