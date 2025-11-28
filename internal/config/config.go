package config

import (
	"fmt"
	"os"
	"time"

	"github.com/microsoft/amplifier/swarm/internal/errors"
)

const (
	DefaultSessionName = "swarm"
	DefaultBaseBranch  = "main"
)

type Config struct {
	ReposDir              string        // Base directory for repositories (REQUIRED)
	SessionName           string        // Tmux session name (defaults to "swarm")
	DefaultBaseBranch     string        // Default base branch for new worktrees
	CreateSessionOnCreate bool          // Auto-create tmux session when creating worktree
	TmuxLayoutScript      string        // Optional script for tmux layout
	StatusCacheTTL        time.Duration // Cache TTL for status checks
}

// Validate checks that required configuration is present and valid
func (c *Config) Validate() error {
	// ReposDir is required
	if c.ReposDir == "" {
		return fmt.Errorf("%w: ReposDir is required", errors.ErrReposDirNotFound)
	}

	// ReposDir must exist
	info, err := os.Stat(c.ReposDir)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("%w: %s", errors.ErrReposDirNotFound, c.ReposDir)
		}
		return fmt.Errorf("checking ReposDir: %w", err)
	}

	// ReposDir must be a directory
	if !info.IsDir() {
		return fmt.Errorf("ReposDir is not a directory: %s", c.ReposDir)
	}

	// Apply defaults for optional fields
	if c.SessionName == "" {
		c.SessionName = DefaultSessionName
	}
	if c.DefaultBaseBranch == "" {
		c.DefaultBaseBranch = DefaultBaseBranch
	}
	if c.StatusCacheTTL == 0 {
		c.StatusCacheTTL = 30 * time.Second
	}

	return nil
}

// NewConfig creates a new Config with defaults applied
func NewConfig(reposDir string) *Config {
	return &Config{
		ReposDir:              reposDir,
		SessionName:           DefaultSessionName,
		DefaultBaseBranch:     DefaultBaseBranch,
		CreateSessionOnCreate: true,
		StatusCacheTTL:        30 * time.Second,
	}
}
