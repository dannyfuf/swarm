package repo

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/microsoft/amplifier/swarm/internal/config"
	"github.com/microsoft/amplifier/swarm/internal/git"
)

type Discovery struct {
	config *config.Config
	git    *git.Client
}

func NewDiscovery(cfg *config.Config, gitClient *git.Client) *Discovery {
	return &Discovery{
		config: cfg,
		git:    gitClient,
	}
}

func (d *Discovery) ScanAll() ([]Repo, error) {
	entries, err := os.ReadDir(d.config.AIWorkingDir)
	if err != nil {
		return nil, fmt.Errorf("reading ai_working_dir: %w", err)
	}

	var repos []Repo
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		// Skip worktree directories (contain __wt__)
		if strings.Contains(entry.Name(), "__wt__") {
			continue
		}

		repoPath := filepath.Join(d.config.AIWorkingDir, entry.Name())

		// Check if it's a git repo
		gitDir := filepath.Join(repoPath, ".git")
		if _, err := os.Stat(gitDir); err != nil {
			continue
		}

		// Get default branch
		defaultBranch, err := d.git.DefaultBranch(repoPath)
		if err != nil {
			defaultBranch = d.config.DefaultBaseBranch
		}

		repos = append(repos, Repo{
			Name:          entry.Name(),
			Path:          repoPath,
			DefaultBranch: defaultBranch,
		})
	}

	return repos, nil
}

func (d *Discovery) FindByName(name string) (*Repo, error) {
	repoPath := filepath.Join(d.config.AIWorkingDir, name)

	// Check if directory exists
	if _, err := os.Stat(repoPath); err != nil {
		return nil, fmt.Errorf("repo not found: %s", name)
	}

	// Check if it's a git repo
	gitDir := filepath.Join(repoPath, ".git")
	if _, err := os.Stat(gitDir); err != nil {
		return nil, fmt.Errorf("not a git repository: %s", name)
	}

	// Get default branch
	defaultBranch, err := d.git.DefaultBranch(repoPath)
	if err != nil {
		defaultBranch = d.config.DefaultBaseBranch
	}

	return &Repo{
		Name:          name,
		Path:          repoPath,
		DefaultBranch: defaultBranch,
	}, nil
}
