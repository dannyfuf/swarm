package service

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/microsoft/amplifier/swarm/internal/config"
	"github.com/microsoft/amplifier/swarm/internal/git"
	"github.com/microsoft/amplifier/swarm/internal/repo"
	"github.com/microsoft/amplifier/swarm/internal/state"
	"github.com/microsoft/amplifier/swarm/internal/tmux"
	"github.com/microsoft/amplifier/swarm/internal/worktree"
)

type WorktreeService struct {
	config    *config.Config
	git       *git.Client
	tmux      *tmux.Client
	state     *state.Store
	discovery *repo.Discovery
	worktree  *worktree.Manager
}

func NewWorktreeService(cfg *config.Config) (*WorktreeService, error) {
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("invalid config: %w", err)
	}

	gitClient := git.NewClient()
	tmuxClient := tmux.NewClient()
	stateStore := state.NewStore(cfg.ReposDir)
	discoveryService := repo.NewDiscovery(cfg, gitClient)
	worktreeManager := worktree.NewManager(cfg, gitClient, stateStore)

	exists, err := tmuxClient.HasSession(cfg.SessionName)
	if err != nil {
		return nil, fmt.Errorf("checking tmux session: %w", err)
	}

	if !exists {
		if err := tmuxClient.CreateSession(cfg.SessionName, cfg.ReposDir); err != nil {
			return nil, fmt.Errorf("creating tmux session: %w", err)
		}
	}

	return &WorktreeService{
		config:    cfg,
		git:       gitClient,
		tmux:      tmuxClient,
		state:     stateStore,
		discovery: discoveryService,
		worktree:  worktreeManager,
	}, nil
}

func (s *WorktreeService) GetSessionName() string {
	return s.config.SessionName
}

func (s *WorktreeService) ListLocalRepos() ([]repo.Repo, error) {
	repos, err := s.discovery.ScanAll()
	if err != nil {
		return nil, fmt.Errorf("scanning local repos: %w", err)
	}
	return repos, nil
}

func (s *WorktreeService) ListRemoteRepos() ([]git.RemoteRepo, error) {
	remoteRepos, err := s.git.ListRemoteRepos()
	if err != nil {
		return nil, fmt.Errorf("listing remote repos: %w", err)
	}
	return remoteRepos, nil
}

func (s *WorktreeService) CloneRepo(repoURL string) (*repo.Repo, error) {
	repoName := extractRepoName(repoURL)
	targetPath := filepath.Join(s.config.ReposDir, repoName)

	if err := s.git.Clone(repoURL, targetPath); err != nil {
		return nil, fmt.Errorf("cloning repo: %w", err)
	}

	r, err := s.discovery.FindByName(repoName)
	if err != nil {
		return nil, fmt.Errorf("finding cloned repo: %w", err)
	}

	return r, nil
}

func (s *WorktreeService) SelectRepo(repoName string) error {
	r, err := s.discovery.FindByName(repoName)
	if err != nil {
		return fmt.Errorf("finding repo: %w", err)
	}

	if err := s.state.SetSelectedRepo(r.Name); err != nil {
		return fmt.Errorf("setting selected repo: %w", err)
	}

	return nil
}

func (s *WorktreeService) ListWorktrees(repoName string) ([]worktree.Worktree, error) {
	r, err := s.discovery.FindByName(repoName)
	if err != nil {
		return nil, fmt.Errorf("finding repo: %w", err)
	}

	worktrees, err := s.worktree.List(r)
	if err != nil {
		return nil, fmt.Errorf("listing worktrees: %w", err)
	}

	return worktrees, nil
}

func (s *WorktreeService) CreateWorktree(repoName, branchName string) (*worktree.Worktree, error) {
	r, err := s.discovery.FindByName(repoName)
	if err != nil {
		return nil, fmt.Errorf("finding repo: %w", err)
	}

	opts := worktree.CreateOptions{
		Branch:     branchName,
		BaseBranch: r.DefaultBranch,
		NewBranch:  true,
	}

	wt, err := s.worktree.Create(r, opts)
	if err != nil {
		return nil, fmt.Errorf("creating worktree: %w", err)
	}

	return wt, nil
}

func (s *WorktreeService) SelectWorktree(repoName, worktreeSlug string) error {
	r, err := s.discovery.FindByName(repoName)
	if err != nil {
		return fmt.Errorf("finding repo: %w", err)
	}

	worktrees, err := s.worktree.List(r)
	if err != nil {
		return fmt.Errorf("listing worktrees: %w", err)
	}

	found := false
	for _, wt := range worktrees {
		if wt.Slug == worktreeSlug {
			found = true
			break
		}
	}

	if !found {
		return fmt.Errorf("worktree not found: %s", worktreeSlug)
	}

	if err := s.state.SetSelectedWorktree(worktreeSlug); err != nil {
		return fmt.Errorf("setting selected worktree: %w", err)
	}

	return nil
}

func (s *WorktreeService) RebaseWorktree(repoName, worktreeSlug string) error {
	r, err := s.discovery.FindByName(repoName)
	if err != nil {
		return fmt.Errorf("finding repo: %w", err)
	}

	worktrees, err := s.worktree.List(r)
	if err != nil {
		return fmt.Errorf("listing worktrees: %w", err)
	}

	var targetWorktree *worktree.Worktree
	for _, wt := range worktrees {
		if wt.Slug == worktreeSlug {
			wtCopy := wt
			targetWorktree = &wtCopy
			break
		}
	}

	if targetWorktree == nil {
		return fmt.Errorf("worktree not found: %s", worktreeSlug)
	}

	if err := s.git.RebaseWithMain(targetWorktree.Path, r.DefaultBranch); err != nil {
		return fmt.Errorf("rebasing worktree: %w", err)
	}

	return nil
}

func (s *WorktreeService) RemoveOrphanWorktrees(repoName string) error {
	r, err := s.discovery.FindByName(repoName)
	if err != nil {
		return fmt.Errorf("finding repo: %w", err)
	}

	removed, err := s.git.RemoveOrphanWorktrees(r.Path)
	if err != nil {
		return fmt.Errorf("removing orphan worktrees: %w", err)
	}

	for _, path := range removed {
		st, err := s.state.Load()
		if err != nil {
			continue
		}

		if repoState, ok := st.Repos[repoName]; ok {
			for slug, wt := range repoState.Worktrees {
				if wt.Path == path {
					s.state.RemoveWorktree(repoName, slug)
					break
				}
			}
		}
	}

	return nil
}

func (s *WorktreeService) ListWindows(repoName, worktreeSlug string) ([]tmux.Window, error) {
	prefix := fmt.Sprintf("%s:%s:", repoName, worktreeSlug)

	windows, err := s.tmux.ListWindows(s.config.SessionName, prefix)
	if err != nil {
		return nil, fmt.Errorf("listing windows: %w", err)
	}

	return windows, nil
}

func (s *WorktreeService) CreateWindow(repoName, worktreeSlug, windowName string) (*tmux.Window, error) {
	r, err := s.discovery.FindByName(repoName)
	if err != nil {
		return nil, fmt.Errorf("finding repo: %w", err)
	}

	worktrees, err := s.worktree.List(r)
	if err != nil {
		return nil, fmt.Errorf("listing worktrees: %w", err)
	}

	var worktreePath string
	for _, wt := range worktrees {
		if wt.Slug == worktreeSlug {
			worktreePath = wt.Path
			break
		}
	}

	if worktreePath == "" {
		return nil, fmt.Errorf("worktree not found: %s", worktreeSlug)
	}

	wn := tmux.WindowName{
		Repo:     repoName,
		Worktree: worktreeSlug,
		Name:     windowName,
	}

	window, err := s.tmux.CreateWindow(s.config.SessionName, wn, worktreePath)
	if err != nil {
		return nil, fmt.Errorf("creating window: %w", err)
	}

	if err := s.state.AddWindowToWorktree(repoName, worktreeSlug, wn.Format()); err != nil {
		return nil, fmt.Errorf("updating state: %w", err)
	}

	return window, nil
}

func (s *WorktreeService) SelectWindow(repoName, worktreeSlug, windowName string) error {
	fullWindowName := fmt.Sprintf("%s:%s:%s", repoName, worktreeSlug, windowName)

	if err := s.tmux.SelectWindow(s.config.SessionName, fullWindowName); err != nil {
		return fmt.Errorf("selecting window: %w", err)
	}

	if err := s.state.SetSelectedWindow(fullWindowName); err != nil {
		return fmt.Errorf("updating state: %w", err)
	}

	return nil
}

func (s *WorktreeService) DeleteWindow(repoName, worktreeSlug, windowName string) error {
	fullWindowName := fmt.Sprintf("%s:%s:%s", repoName, worktreeSlug, windowName)

	if err := s.tmux.DeleteWindow(s.config.SessionName, fullWindowName); err != nil {
		return fmt.Errorf("deleting window: %w", err)
	}

	if err := s.state.RemoveWindowFromWorktree(repoName, worktreeSlug, fullWindowName); err != nil {
		return fmt.Errorf("updating state: %w", err)
	}

	return nil
}

func (s *WorktreeService) RenameWindow(repoName, worktreeSlug, oldName, newName string) error {
	oldFullName := fmt.Sprintf("%s:%s:%s", repoName, worktreeSlug, oldName)

	if err := s.tmux.RenameWindow(s.config.SessionName, oldFullName, newName); err != nil {
		return fmt.Errorf("renaming window: %w", err)
	}

	newFullName := fmt.Sprintf("%s:%s:%s", repoName, worktreeSlug, newName)

	if err := s.state.RemoveWindowFromWorktree(repoName, worktreeSlug, oldFullName); err != nil {
		return fmt.Errorf("removing old window from state: %w", err)
	}

	if err := s.state.AddWindowToWorktree(repoName, worktreeSlug, newFullName); err != nil {
		return fmt.Errorf("adding new window to state: %w", err)
	}

	return nil
}

func (s *WorktreeService) GetCurrentSelection() (*state.SelectionState, error) {
	selection, err := s.state.GetCurrentSelection()
	if err != nil {
		return nil, fmt.Errorf("getting current selection: %w", err)
	}
	return selection, nil
}

func extractRepoName(url string) string {
	url = strings.TrimSuffix(url, ".git")

	parts := strings.Split(url, "/")
	if len(parts) > 0 {
		return parts[len(parts)-1]
	}

	return "repo"
}
