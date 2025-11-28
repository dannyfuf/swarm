package worktree

import (
	"fmt"
	"path/filepath"
	"time"

	"github.com/microsoft/amplifier/swarm/internal/config"
	"github.com/microsoft/amplifier/swarm/internal/git"
	"github.com/microsoft/amplifier/swarm/internal/repo"
	"github.com/microsoft/amplifier/swarm/internal/state"
)

type Manager struct {
	config *config.Config
	git    *git.Client
	state  *state.Store
}

func NewManager(cfg *config.Config, gitClient *git.Client, stateStore *state.Store) *Manager {
	return &Manager{
		config: cfg,
		git:    gitClient,
		state:  stateStore,
	}
}

func (m *Manager) Create(r *repo.Repo, opts CreateOptions) (*Worktree, error) {
	// Load state to check for existing slugs
	st, err := m.state.Load()
	if err != nil {
		return nil, fmt.Errorf("loading state: %w", err)
	}

	// Build existing slug map
	existing := make(map[string]string)
	if repoState := st.Repos[r.Name]; repoState != nil {
		for slug, wt := range repoState.Worktrees {
			existing[slug] = wt.Branch
		}
	}

	// Generate unique slug
	slug := GenerateUniqueSlug(opts.Branch, existing)

	// Determine worktree path - use pattern: repos_dir/repo__wt__slug
	worktreePath := filepath.Join(m.config.ReposDir, fmt.Sprintf("%s__wt__%s", r.Name, slug))

	// Create git worktree
	gitOpts := git.AddOptions{
		Path:       worktreePath,
		Branch:     opts.Branch,
		BaseBranch: opts.BaseBranch,
		NewBranch:  opts.NewBranch,
	}

	if err := m.git.WorktreeAdd(r.Path, gitOpts); err != nil {
		return nil, fmt.Errorf("creating git worktree: %w", err)
	}

	// Create worktree object
	wt := &Worktree{
		Slug:      slug,
		Branch:    opts.Branch,
		Path:      worktreePath,
		RepoName:  r.Name,
		CreatedAt: time.Now(),
	}

	// Save to state
	stateWt := &state.WorktreeState{
		Slug:      wt.Slug,
		Branch:    wt.Branch,
		Path:      wt.Path,
		CreatedAt: wt.CreatedAt,
	}

	if err := m.state.UpdateWorktree(r.Name, stateWt); err != nil {
		return nil, fmt.Errorf("updating state: %w", err)
	}

	return wt, nil
}

func (m *Manager) List(r *repo.Repo) ([]Worktree, error) {
	// Get from git
	gitWorktrees, err := m.git.WorktreeList(r.Path)
	if err != nil {
		return nil, fmt.Errorf("listing git worktrees: %w", err)
	}

	// Load state
	st, err := m.state.Load()
	if err != nil {
		return nil, fmt.Errorf("loading state: %w", err)
	}

	var worktrees []Worktree
	for _, gitWt := range gitWorktrees {
		// Skip the main repo worktree
		if gitWt.Path == r.Path {
			continue
		}

		// Find matching state
		var stateWt *state.WorktreeState
		if repoState := st.Repos[r.Name]; repoState != nil {
			for _, wt := range repoState.Worktrees {
				if wt.Path == gitWt.Path {
					stateWt = wt
					break
				}
			}
		}

		wt := Worktree{
			Branch:   gitWt.Branch,
			Path:     gitWt.Path,
			RepoName: r.Name,
		}

		if stateWt != nil {
			wt.Slug = stateWt.Slug
			wt.CreatedAt = stateWt.CreatedAt
			wt.LastOpenedAt = stateWt.LastOpenedAt
			wt.TmuxSession = stateWt.TmuxSession
		} else {
			// Generate slug from branch if not in state
			wt.Slug = GenerateSlug(gitWt.Branch)
		}

		worktrees = append(worktrees, wt)
	}

	return worktrees, nil
}

func (m *Manager) Remove(wt *Worktree, force bool) error {
	// Remove from git
	// Use the repo path (parent of worktree)
	repoPath := filepath.Join(m.config.ReposDir, wt.RepoName)

	if err := m.git.WorktreeRemove(repoPath, wt.Path); err != nil {
		if !force {
			return fmt.Errorf("removing git worktree: %w", err)
		}
		// If force, continue even if git remove fails
	}

	// Remove from state
	if err := m.state.RemoveWorktree(wt.RepoName, wt.Slug); err != nil {
		return fmt.Errorf("removing from state: %w", err)
	}

	return nil
}
