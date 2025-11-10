package state

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestStoreLoadEmpty(t *testing.T) {
	tmpDir := t.TempDir()
	store := NewStore(tmpDir)

	state, err := store.Load()
	require.NoError(t, err)
	assert.NotNil(t, state)
	assert.Equal(t, 1, state.Version)
	assert.Empty(t, state.Repos)
}

func TestStoreSaveLoad(t *testing.T) {
	tmpDir := t.TempDir()
	store := NewStore(tmpDir)

	// Create state
	state := &State{
		Version:   1,
		UpdatedAt: time.Now(),
		Repos: map[string]*RepoState{
			"test-repo": {
				Path:          "/path/to/repo",
				DefaultBranch: "main",
				Worktrees: map[string]*WorktreeState{
					"feature_foo": {
						Slug:      "feature_foo",
						Branch:    "feature/foo",
						Path:      "/path/to/worktree",
						CreatedAt: time.Now(),
					},
				},
			},
		},
	}

	// Save
	err := store.Save(state)
	require.NoError(t, err)

	// Verify file exists
	assert.FileExists(t, filepath.Join(tmpDir, ".swarm-state.json"))

	// Load
	loaded, err := store.Load()
	require.NoError(t, err)
	assert.Equal(t, "/path/to/repo", loaded.Repos["test-repo"].Path)
	assert.Equal(t, "feature_foo", loaded.Repos["test-repo"].Worktrees["feature_foo"].Slug)
}

func TestStoreUpdateWorktree(t *testing.T) {
	tmpDir := t.TempDir()
	store := NewStore(tmpDir)

	// Update worktree (creates repo if needed)
	wt := &WorktreeState{
		Slug:      "feature_bar",
		Branch:    "feature/bar",
		Path:      "/path/to/bar",
		CreatedAt: time.Now(),
	}

	err := store.UpdateWorktree("test-repo", wt)
	require.NoError(t, err)

	// Verify
	state, _ := store.Load()
	assert.Contains(t, state.Repos, "test-repo")
	assert.Contains(t, state.Repos["test-repo"].Worktrees, "feature_bar")
}
