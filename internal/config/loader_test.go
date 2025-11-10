package config

import (
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoaderDefaults(t *testing.T) {
	// Setup
	tmpDir := t.TempDir()
	os.Setenv("AI_WORKING_DIR", tmpDir)
	defer os.Unsetenv("AI_WORKING_DIR")

	// Execute
	loader := NewLoader()
	cfg, err := loader.Load()

	// Verify
	require.NoError(t, err)
	assert.Equal(t, tmpDir, cfg.AIWorkingDir)
	assert.Equal(t, "main", cfg.DefaultBaseBranch)
	assert.Equal(t, "patternA", cfg.WorktreePattern)
}

func TestLoaderEnvOverride(t *testing.T) {
	// Setup
	tmpDir := t.TempDir()
	os.Setenv("AI_WORKING_DIR", tmpDir)
	os.Setenv("SWARM_DEFAULT_BASE_BRANCH", "develop")
	defer func() {
		os.Unsetenv("AI_WORKING_DIR")
		os.Unsetenv("SWARM_DEFAULT_BASE_BRANCH")
	}()

	// Execute
	loader := NewLoader()
	cfg, err := loader.Load()

	// Verify
	require.NoError(t, err)
	assert.Equal(t, "develop", cfg.DefaultBaseBranch)
}

func TestValidateInvalidDir(t *testing.T) {
	cfg := &Config{
		AIWorkingDir: "/nonexistent/path",
	}

	err := cfg.Validate()
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "does not exist")
}
