package config

import (
	"errors"
	"os"
)

func (c *Config) Validate() error {
	// Check ai_working_dir exists
	if _, err := os.Stat(c.AIWorkingDir); err != nil {
		return errors.New("ai_working_dir does not exist or is not accessible")
	}

	// Check worktree_pattern is valid
	validPatterns := map[string]bool{
		"patternA": true,
		"patternB": true,
		"patternC": true,
	}
	if !validPatterns[c.WorktreePattern] {
		return errors.New("worktree_pattern must be patternA, patternB, or patternC")
	}

	return nil
}
