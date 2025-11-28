package service

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/microsoft/amplifier/swarm/internal/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewWorktreeServiceValidation(t *testing.T) {
	// Check if tmux is available
	_, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux not installed, skipping service tests")
	}

	tmpDir := t.TempDir()

	t.Run("fails when ReposDir missing", func(t *testing.T) {
		cfg := &config.Config{
			ReposDir:          "",
			SessionName:       "swarm-test",
			DefaultBaseBranch: "main",
		}
		_, err := NewWorktreeService(cfg)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "ReposDir is required")
	})

	t.Run("fails when ReposDir doesn't exist", func(t *testing.T) {
		cfg := &config.Config{
			ReposDir:          filepath.Join(tmpDir, "nonexistent"),
			SessionName:       "swarm-test",
			DefaultBaseBranch: "main",
		}
		_, err := NewWorktreeService(cfg)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "repos directory not found")
	})

	t.Run("succeeds with valid config", func(t *testing.T) {
		validDir := filepath.Join(tmpDir, "valid")
		err := os.MkdirAll(validDir, 0755)
		require.NoError(t, err)

		cfg := &config.Config{
			ReposDir:          validDir,
			SessionName:       "swarm-test-valid",
			DefaultBaseBranch: "main",
		}
		svc, err := NewWorktreeService(cfg)
		if err != nil {
			t.Logf("Warning: Could not create service (tmux may not be running): %v", err)
			t.Skip("Skipping due to tmux requirement")
		}
		require.NotNil(t, svc)
		assert.NotNil(t, svc.config)
		assert.NotNil(t, svc.state)
		assert.NotNil(t, svc.git)
		assert.NotNil(t, svc.tmux)

		// Clean up tmux session
		exec.Command("tmux", "kill-session", "-t", "swarm-test-valid").Run()
	})
}

func TestConfigValidationInService(t *testing.T) {
	// These tests validate that service respects config validation
	// without requiring tmux to be running

	t.Run("config validation is called", func(t *testing.T) {
		cfg := &config.Config{
			ReposDir:          "", // Invalid
			SessionName:       "test",
			DefaultBaseBranch: "main",
		}
		_, err := NewWorktreeService(cfg)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "invalid config")
	})

	t.Run("config defaults are applied", func(t *testing.T) {
		tmpDir := t.TempDir()
		cfg := &config.Config{
			ReposDir:          tmpDir,
			SessionName:       "", // Should default to "swarm"
			DefaultBaseBranch: "", // Should default to "main"
		}

		// Validate to apply defaults
		err := cfg.Validate()
		require.NoError(t, err)

		assert.Equal(t, "swarm", cfg.SessionName)
		assert.Equal(t, "main", cfg.DefaultBaseBranch)
	})
}
