//go:build integration

package integration

import (
	"os/exec"
	"testing"

	"github.com/microsoft/amplifier/swarm/internal/tmux"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTmuxWindowOperations(t *testing.T) {
	// Skip if tmux not available
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available")
	}

	client := tmux.NewClient()
	sessionName := "swarm-test-session"

	// Cleanup any existing test session
	client.KillSession(sessionName)
	defer client.KillSession(sessionName)

	t.Run("can create session", func(t *testing.T) {
		err := client.CreateSession(sessionName, "/tmp")
		assert.NoError(t, err)

		exists, _ := client.HasSession(sessionName)
		assert.True(t, exists)
	})

	t.Run("can create window with naming convention", func(t *testing.T) {
		wn := tmux.WindowName{
			Repo:     "test-repo",
			Worktree: "feature_x",
			Name:     "editor",
		}

		_, err := client.CreateWindow(sessionName, wn, "/tmp")
		assert.NoError(t, err)
	})

	t.Run("can list windows with prefix filter", func(t *testing.T) {
		windows, err := client.ListWindows(sessionName, "test-repo:feature_x:")
		assert.NoError(t, err)
		assert.GreaterOrEqual(t, len(windows), 1)
	})

	t.Run("can rename window preserving prefix", func(t *testing.T) {
		oldName := "test-repo:feature_x:editor"
		newLabel := "shell"

		err := client.RenameWindow(sessionName, oldName, newLabel)
		require.NoError(t, err)

		// Verify the rename worked and prefix was preserved
		windows, err := client.ListWindows(sessionName, "test-repo:feature_x:")
		require.NoError(t, err)

		var found *tmux.Window
		for _, w := range windows {
			if w.Name.Name == newLabel {
				found = &w
				break
			}
		}

		require.NotNil(t, found, "renamed window should exist")

		// CRITICAL: Verify prefix components were preserved
		assert.Equal(t, "test-repo", found.Name.Repo, "Repo component should be preserved")
		assert.Equal(t, "feature_x", found.Name.Worktree, "Worktree component should be preserved")
		assert.Equal(t, "shell", found.Name.Name, "Name component should be updated")
	})
}
