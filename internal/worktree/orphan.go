package worktree

import (
	"fmt"
	"time"

	"github.com/microsoft/amplifier/swarm/internal/git"
	"github.com/microsoft/amplifier/swarm/internal/repo"
	"github.com/microsoft/amplifier/swarm/internal/state"
)

// OrphanDetector finds inconsistencies between state and git
type OrphanDetector struct {
	git   *git.Client
	state *state.Store
}

func NewOrphanDetector(gitClient *git.Client, stateStore *state.Store) *OrphanDetector {
	return &OrphanDetector{
		git:   gitClient,
		state: stateStore,
	}
}

// DetectOrphans finds worktrees in state but not in git
func (d *OrphanDetector) DetectOrphans(r *repo.Repo) ([]OrphanedWorktree, error) {
	// Get git reality
	gitWorktrees, err := d.git.WorktreeList(r.Path)
	if err != nil {
		return nil, fmt.Errorf("listing git worktrees: %w", err)
	}

	// Build set of git paths
	gitPaths := make(map[string]bool)
	for _, wt := range gitWorktrees {
		gitPaths[wt.Path] = true
	}

	// Load state
	st, err := d.state.Load()
	if err != nil {
		return nil, fmt.Errorf("loading state: %w", err)
	}

	repoState := st.Repos[r.Name]
	if repoState == nil {
		return []OrphanedWorktree{}, nil
	}

	// Find orphans
	var orphans []OrphanedWorktree
	for slug, wtState := range repoState.Worktrees {
		if !gitPaths[wtState.Path] {
			orphans = append(orphans, OrphanedWorktree{
				Slug:      slug,
				Branch:    wtState.Branch,
				Path:      wtState.Path,
				CreatedAt: wtState.CreatedAt,
				Reason:    "Not in git worktree list",
			})
		}
	}

	return orphans, nil
}

// OrphanedWorktree represents a stale state entry
type OrphanedWorktree struct {
	Slug      string
	Branch    string
	Path      string
	CreatedAt time.Time
	Reason    string
}

// CleanOrphans removes orphaned entries from state
func (d *OrphanDetector) CleanOrphans(r *repo.Repo, orphans []OrphanedWorktree) error {
	if len(orphans) == 0 {
		return nil
	}

	st, err := d.state.Load()
	if err != nil {
		return fmt.Errorf("loading state: %w", err)
	}

	repoState := st.Repos[r.Name]
	if repoState == nil {
		return nil
	}

	// Remove each orphan
	for _, orphan := range orphans {
		delete(repoState.Worktrees, orphan.Slug)
	}

	// Save updated state
	return d.state.Save(st)
}
