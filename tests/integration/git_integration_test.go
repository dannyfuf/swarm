//go:build integration

package integration

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/microsoft/amplifier/swarm/internal/git"
	"github.com/stretchr/testify/assert"
)

func TestGitWorktreeLifecycle(t *testing.T) {
	// Skip if git not available
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	// Create temp repo
	tmpDir, _ := os.MkdirTemp("", "swarm-git-test")
	defer os.RemoveAll(tmpDir)

	repoPath := filepath.Join(tmpDir, "test-repo")
	os.Mkdir(repoPath, 0755)

	// Initialize repo
	exec.Command("git", "-C", repoPath, "init").Run()
	exec.Command("git", "-C", repoPath, "config", "user.email", "test@test.com").Run()
	exec.Command("git", "-C", repoPath, "config", "user.name", "Test").Run()
	exec.Command("git", "-C", repoPath, "commit", "--allow-empty", "-m", "Initial").Run()

	client := git.NewClient()

	t.Run("can list worktrees", func(t *testing.T) {
		wts, err := client.WorktreeList(repoPath)
		assert.NoError(t, err)
		assert.Len(t, wts, 1) // Main worktree only
	})

	t.Run("can create worktree", func(t *testing.T) {
		wtPath := filepath.Join(tmpDir, "feature-worktree")
		err := client.WorktreeAdd(repoPath, git.AddOptions{
			Path:      wtPath,
			Branch:    "feature",
			NewBranch: true,
		})
		assert.NoError(t, err)

		wts, _ := client.WorktreeList(repoPath)
		assert.Len(t, wts, 2)
	})
}

func TestGitRemoteRepos(t *testing.T) {
	// Skip if gh not available
	if !git.GhCliAvailable() {
		t.Skip("gh CLI not available")
	}

	// Skip if not authenticated
	if err := git.GhCliAuthenticated(); err != nil {
		t.Skip("gh CLI not authenticated")
	}

	client := git.NewClient()

	t.Run("can list remote repos", func(t *testing.T) {
		repos, err := client.ListRemoteRepos()
		assert.NoError(t, err)
		// Just verify we got some repos back (exact count depends on user)
		assert.NotNil(t, repos)
	})
}
