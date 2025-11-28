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

func TestStoreTrackSelection(t *testing.T) {
	tmpDir := t.TempDir()
	store := NewStore(tmpDir)

	t.Run("tracks repo selection", func(t *testing.T) {
		err := store.SetSelectedRepo("my-repo")
		require.NoError(t, err)

		state, err := store.Load()
		require.NoError(t, err)
		assert.Equal(t, "my-repo", state.Selection.SelectedRepo)
		assert.Empty(t, state.Selection.SelectedWorktree)
	})

	t.Run("tracks worktree selection", func(t *testing.T) {
		err := store.SetSelectedRepo("my-repo")
		require.NoError(t, err)

		err = store.SetSelectedWorktree("feature_foo")
		require.NoError(t, err)

		state, err := store.Load()
		require.NoError(t, err)
		assert.Equal(t, "my-repo", state.Selection.SelectedRepo)
		assert.Equal(t, "feature_foo", state.Selection.SelectedWorktree)
	})

	t.Run("clears worktree when repo changes", func(t *testing.T) {
		// First select repo
		err := store.SetSelectedRepo("repo-a")
		require.NoError(t, err)

		// Set worktree
		err = store.SetSelectedWorktree("wt-1")
		require.NoError(t, err)

		state, _ := store.Load()
		assert.Equal(t, "repo-a", state.Selection.SelectedRepo)
		assert.Equal(t, "wt-1", state.Selection.SelectedWorktree)

		// Change to different repo (should clear worktree)
		err = store.SetSelectedRepo("repo-b")
		require.NoError(t, err)

		state, _ = store.Load()
		assert.Equal(t, "repo-b", state.Selection.SelectedRepo)
		assert.Empty(t, state.Selection.SelectedWorktree)
	})

	t.Run("updates worktree in same repo", func(t *testing.T) {
		// Select repo
		err := store.SetSelectedRepo("repo-a")
		require.NoError(t, err)

		// Set first worktree
		err = store.SetSelectedWorktree("wt-1")
		require.NoError(t, err)

		// Set different worktree (repo stays same)
		err = store.SetSelectedWorktree("wt-2")
		require.NoError(t, err)

		state, _ := store.Load()
		assert.Equal(t, "repo-a", state.Selection.SelectedRepo)
		assert.Equal(t, "wt-2", state.Selection.SelectedWorktree)
	})
}

func TestStoreTrackWindow(t *testing.T) {
	tmpDir := t.TempDir()
	store := NewStore(tmpDir)

	t.Run("tracks window selection", func(t *testing.T) {
		err := store.SetSelectedWindow("editor")
		require.NoError(t, err)

		state, err := store.Load()
		require.NoError(t, err)
		assert.Equal(t, "editor", state.Selection.SelectedWindow)
	})

	t.Run("updates window selection", func(t *testing.T) {
		err := store.SetSelectedWindow("terminal")
		require.NoError(t, err)

		err = store.SetSelectedWindow("browser")
		require.NoError(t, err)

		state, err := store.Load()
		require.NoError(t, err)
		assert.Equal(t, "browser", state.Selection.SelectedWindow)
	})

	t.Run("empty window name is valid", func(t *testing.T) {
		err := store.SetSelectedWindow("")
		require.NoError(t, err)

		state, err := store.Load()
		require.NoError(t, err)
		assert.Empty(t, state.Selection.SelectedWindow)
	})
}
