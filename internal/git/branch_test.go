package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// setupTestRepo creates a temporary git repo for testing
func setupTestRepo(t *testing.T) string {
	tmpDir, err := os.MkdirTemp("", "swarm-test-*")
	require.NoError(t, err)

	// Initialize repo
	cmd := exec.Command("git", "init")
	cmd.Dir = tmpDir
	require.NoError(t, cmd.Run())

	// Configure user for commits
	exec.Command("git", "-C", tmpDir, "config", "user.name", "Test User").Run()
	exec.Command("git", "-C", tmpDir, "config", "user.email", "test@example.com").Run()

	// Create initial commit on main branch
	testFile := filepath.Join(tmpDir, "README.md")
	require.NoError(t, os.WriteFile(testFile, []byte("# Test Repo\n"), 0644))

	exec.Command("git", "-C", tmpDir, "add", ".").Run()
	exec.Command("git", "-C", tmpDir, "commit", "-m", "Initial commit").Run()
	exec.Command("git", "-C", tmpDir, "branch", "-M", "main").Run()

	return tmpDir
}

// createBranch creates a test branch
func createBranch(t *testing.T, repoPath, branch string) {
	cmd := exec.Command("git", "-C", repoPath, "branch", branch)
	require.NoError(t, cmd.Run())
}

// makeCommit creates a commit on the specified branch
func makeCommit(t *testing.T, repoPath, branch, filename, content string) {
	// Checkout branch
	exec.Command("git", "-C", repoPath, "checkout", branch).Run()

	// Create file
	testFile := filepath.Join(repoPath, filename)
	require.NoError(t, os.WriteFile(testFile, []byte(content), 0644))

	// Commit
	exec.Command("git", "-C", repoPath, "add", filename).Run()
	cmd := exec.Command("git", "-C", repoPath, "commit", "-m", "Add "+filename)
	require.NoError(t, cmd.Run())
}

func TestBranchExists(t *testing.T) {
	repoPath := setupTestRepo(t)
	defer os.RemoveAll(repoPath)

	client := NewClient()

	// Create test branch
	createBranch(t, repoPath, "test-branch")

	// Test existing branch
	exists, err := client.BranchExists(repoPath, "test-branch")
	if err != nil {
		t.Logf("BranchExists error: %v", err)
	}
	require.NoError(t, err)
	assert.True(t, exists)

	// Test non-existent branch - this should return false, not error
	exists, err = client.BranchExists(repoPath, "nonexistent")
	if err != nil {
		t.Logf("BranchExists error for nonexistent: %v", err)
	}
	require.NoError(t, err)
	assert.False(t, exists)

	// Test main branch exists
	exists, err = client.BranchExists(repoPath, "main")
	if err != nil {
		t.Logf("BranchExists error for main: %v", err)
	}
	require.NoError(t, err)
	assert.True(t, exists)
}

func TestGetBranchInfo_NonExistent(t *testing.T) {
	repoPath := setupTestRepo(t)
	defer os.RemoveAll(repoPath)

	client := NewClient()

	info, err := client.GetBranchInfo(repoPath, "nonexistent")
	require.NoError(t, err)
	assert.False(t, info.Exists)
	assert.Equal(t, "nonexistent", info.Name)
}

func TestGetBranchInfo_EmptyBranch(t *testing.T) {
	repoPath := setupTestRepo(t)
	defer os.RemoveAll(repoPath)

	client := NewClient()

	// Create empty branch (no commits beyond initial)
	createBranch(t, repoPath, "empty")

	info, err := client.GetBranchInfo(repoPath, "empty")
	require.NoError(t, err)
	assert.True(t, info.Exists)
	assert.True(t, info.HasCommits) // Has at least the initial commit
	assert.Greater(t, info.CommitCount, 0)
}

func TestGetBranchInfo_WithCommits(t *testing.T) {
	repoPath := setupTestRepo(t)
	defer os.RemoveAll(repoPath)

	client := NewClient()

	// Create branch with commits
	createBranch(t, repoPath, "feature")
	makeCommit(t, repoPath, "feature", "test1.txt", "content1")
	makeCommit(t, repoPath, "feature", "test2.txt", "content2")

	info, err := client.GetBranchInfo(repoPath, "feature")
	require.NoError(t, err)
	assert.True(t, info.Exists)
	assert.True(t, info.HasCommits)
	assert.Greater(t, info.CommitCount, 2) // At least 3 commits (initial + 2)
	assert.NotNil(t, info.LastCommit)
	assert.Equal(t, "Add test2.txt", info.LastCommit.Message)
}

func TestGetBranchInfo_MergeStatus(t *testing.T) {
	repoPath := setupTestRepo(t)
	defer os.RemoveAll(repoPath)

	client := NewClient()

	// Create and merge a branch
	createBranch(t, repoPath, "merged-feature")
	makeCommit(t, repoPath, "merged-feature", "merged.txt", "content")

	// Merge into main
	exec.Command("git", "-C", repoPath, "checkout", "main").Run()
	exec.Command("git", "-C", repoPath, "merge", "merged-feature", "--no-ff", "-m", "Merge feature").Run()

	info, err := client.GetBranchInfo(repoPath, "merged-feature")
	require.NoError(t, err)
	assert.True(t, info.Exists)
	assert.True(t, info.IsMerged)

	// Create unmerged branch
	createBranch(t, repoPath, "unmerged-feature")
	makeCommit(t, repoPath, "unmerged-feature", "unmerged.txt", "content")

	info, err = client.GetBranchInfo(repoPath, "unmerged-feature")
	require.NoError(t, err)
	assert.True(t, info.Exists)
	assert.False(t, info.IsMerged)
}

func TestDeleteBranch_Safe(t *testing.T) {
	repoPath := setupTestRepo(t)
	defer os.RemoveAll(repoPath)

	client := NewClient()

	// Create and merge a branch
	createBranch(t, repoPath, "to-delete")
	makeCommit(t, repoPath, "to-delete", "test.txt", "content")

	// Merge it
	exec.Command("git", "-C", repoPath, "checkout", "main").Run()
	exec.Command("git", "-C", repoPath, "merge", "to-delete", "--no-ff", "-m", "Merge").Run()

	// Should delete safely
	err := client.DeleteBranch(repoPath, "to-delete", false)
	require.NoError(t, err)

	// Verify deleted
	exists, _ := client.BranchExists(repoPath, "to-delete")
	assert.False(t, exists)
}

func TestDeleteBranch_Unmerged_WithoutForce(t *testing.T) {
	repoPath := setupTestRepo(t)
	defer os.RemoveAll(repoPath)

	client := NewClient()

	// Create unmerged branch
	createBranch(t, repoPath, "unmerged")
	makeCommit(t, repoPath, "unmerged", "test.txt", "content")

	// Switch back to main
	exec.Command("git", "-C", repoPath, "checkout", "main").Run()

	// Safe delete should fail
	err := client.DeleteBranch(repoPath, "unmerged", false)
	assert.Error(t, err)

	// Branch should still exist
	exists, _ := client.BranchExists(repoPath, "unmerged")
	assert.True(t, exists)
}

func TestDeleteBranch_Unmerged_WithForce(t *testing.T) {
	repoPath := setupTestRepo(t)
	defer os.RemoveAll(repoPath)

	client := NewClient()

	// Create unmerged branch
	createBranch(t, repoPath, "unmerged")
	makeCommit(t, repoPath, "unmerged", "test.txt", "content")

	// Switch back to main
	exec.Command("git", "-C", repoPath, "checkout", "main").Run()

	// Force delete should succeed
	err := client.DeleteBranch(repoPath, "unmerged", true)
	require.NoError(t, err)

	// Branch should be deleted
	exists, _ := client.BranchExists(repoPath, "unmerged")
	assert.False(t, exists)
}

func TestDeleteBranch_NonExistent(t *testing.T) {
	repoPath := setupTestRepo(t)
	defer os.RemoveAll(repoPath)

	client := NewClient()

	// Try to delete non-existent branch
	err := client.DeleteBranch(repoPath, "nonexistent", false)
	assert.Error(t, err)
}
