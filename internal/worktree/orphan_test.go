package worktree

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/microsoft/amplifier/swarm/internal/git"
	"github.com/microsoft/amplifier/swarm/internal/repo"
	"github.com/microsoft/amplifier/swarm/internal/state"
)

func TestDetectOrphans(t *testing.T) {
	// Create temp dir for state and git repo
	tmpDir := t.TempDir()
	stateDir := filepath.Join(tmpDir, "state")
	gitDir := filepath.Join(tmpDir, "repo")

	if err := os.MkdirAll(stateDir, 0755); err != nil {
		t.Fatalf("Failed to create state dir: %v", err)
	}
	if err := os.MkdirAll(gitDir, 0755); err != nil {
		t.Fatalf("Failed to create git dir: %v", err)
	}

	// Initialize a git repo
	if err := exec.Command("git", "init", gitDir).Run(); err != nil {
		t.Skipf("Skipping test: git not available: %v", err)
	}

	stateStore := state.NewStore(stateDir)
	gitClient := git.NewClient()
	detector := NewOrphanDetector(gitClient, stateStore)

	// Create test repo
	testRepo := &repo.Repo{
		Name: "test-repo",
		Path: gitDir,
	}

	// Add a worktree to state that doesn't exist in git
	st := &state.State{
		Version:   1,
		UpdatedAt: time.Now(),
		Repos: map[string]*state.RepoState{
			"test-repo": {
				Path:          gitDir,
				DefaultBranch: "main",
				LastScanned:   time.Now(),
				Worktrees: map[string]*state.WorktreeState{
					"test-slug": {
						Slug:      "test-slug",
						Branch:    "test-branch",
						Path:      filepath.Join(tmpDir, "nonexistent"),
						CreatedAt: time.Now(),
					},
				},
			},
		},
	}

	if err := stateStore.Save(st); err != nil {
		t.Fatalf("Failed to save state: %v", err)
	}

	// Detect orphans - should find the worktree we added
	// because it's not in git's worktree list
	orphans, err := detector.DetectOrphans(testRepo)
	if err != nil {
		t.Fatalf("DetectOrphans failed: %v", err)
	}

	if len(orphans) != 1 {
		t.Errorf("Expected 1 orphan, got %d", len(orphans))
	}

	if len(orphans) > 0 && orphans[0].Slug != "test-slug" {
		t.Errorf("Expected orphan slug 'test-slug', got '%s'", orphans[0].Slug)
	}
}

func TestCleanOrphans(t *testing.T) {
	// Create temp dir for state
	tmpDir := t.TempDir()
	stateStore := state.NewStore(tmpDir)
	gitClient := git.NewClient()

	detector := NewOrphanDetector(gitClient, stateStore)

	testRepo := &repo.Repo{
		Name: "test-repo",
		Path: tmpDir,
	}

	// Create state with orphaned worktree
	st := &state.State{
		Version:   1,
		UpdatedAt: time.Now(),
		Repos: map[string]*state.RepoState{
			"test-repo": {
				Worktrees: map[string]*state.WorktreeState{
					"orphan-slug": {
						Slug:   "orphan-slug",
						Branch: "orphan-branch",
						Path:   "/nonexistent/path",
					},
					"valid-slug": {
						Slug:   "valid-slug",
						Branch: "valid-branch",
						Path:   "/valid/path",
					},
				},
			},
		},
	}

	if err := stateStore.Save(st); err != nil {
		t.Fatalf("Failed to save state: %v", err)
	}

	// Create orphan list
	orphans := []OrphanedWorktree{
		{
			Slug:   "orphan-slug",
			Branch: "orphan-branch",
			Path:   "/nonexistent/path",
			Reason: "Not in git worktree list",
		},
	}

	// Clean orphans
	if err := detector.CleanOrphans(testRepo, orphans); err != nil {
		t.Fatalf("CleanOrphans failed: %v", err)
	}

	// Verify orphan was removed
	loadedState, err := stateStore.Load()
	if err != nil {
		t.Fatalf("Failed to load state: %v", err)
	}

	repoState := loadedState.Repos["test-repo"]
	if repoState == nil {
		t.Fatal("Repo state not found")
	}

	if _, exists := repoState.Worktrees["orphan-slug"]; exists {
		t.Error("Orphan worktree should have been removed")
	}

	if _, exists := repoState.Worktrees["valid-slug"]; !exists {
		t.Error("Valid worktree should still exist")
	}
}

func TestDetectOrphansEmptyState(t *testing.T) {
	tmpDir := t.TempDir()
	stateDir := filepath.Join(tmpDir, "state")
	gitDir := filepath.Join(tmpDir, "repo")

	if err := os.MkdirAll(stateDir, 0755); err != nil {
		t.Fatalf("Failed to create state dir: %v", err)
	}
	if err := os.MkdirAll(gitDir, 0755); err != nil {
		t.Fatalf("Failed to create git dir: %v", err)
	}

	// Initialize a git repo
	if err := exec.Command("git", "init", gitDir).Run(); err != nil {
		t.Skipf("Skipping test: git not available: %v", err)
	}

	stateStore := state.NewStore(stateDir)
	gitClient := git.NewClient()
	detector := NewOrphanDetector(gitClient, stateStore)

	testRepo := &repo.Repo{
		Name: "test-repo",
		Path: gitDir,
	}

	// Don't create any state - should return empty list
	orphans, err := detector.DetectOrphans(testRepo)
	if err != nil {
		t.Fatalf("DetectOrphans failed: %v", err)
	}

	if len(orphans) != 0 {
		t.Errorf("Expected 0 orphans for empty state, got %d", len(orphans))
	}
}

func TestCleanOrphansEmpty(t *testing.T) {
	tmpDir := t.TempDir()
	stateStore := state.NewStore(tmpDir)
	gitClient := git.NewClient()

	detector := NewOrphanDetector(gitClient, stateStore)

	testRepo := &repo.Repo{
		Name: "test-repo",
		Path: tmpDir,
	}

	// Clean with empty orphan list - should not error
	err := detector.CleanOrphans(testRepo, []OrphanedWorktree{})
	if err != nil {
		t.Errorf("CleanOrphans with empty list should not error: %v", err)
	}
}

func TestDetectOrphansGitError(t *testing.T) {
	tmpDir := t.TempDir()
	stateStore := state.NewStore(tmpDir)
	gitClient := git.NewClient()

	detector := NewOrphanDetector(gitClient, stateStore)

	// Use a path that's definitely not a git repo and doesn't exist
	nonExistentPath := filepath.Join(tmpDir, "does-not-exist-at-all")
	testRepo := &repo.Repo{
		Name: "test-repo",
		Path: nonExistentPath,
	}

	// Create some state
	st := &state.State{
		Version:   1,
		UpdatedAt: time.Now(),
		Repos: map[string]*state.RepoState{
			"test-repo": {
				Worktrees: map[string]*state.WorktreeState{
					"test-slug": {
						Slug:   "test-slug",
						Branch: "test-branch",
						Path:   "/some/path",
					},
				},
			},
		},
	}

	if err := stateStore.Save(st); err != nil {
		t.Fatalf("Failed to save state: %v", err)
	}

	// Should return error when git command fails
	_, err := detector.DetectOrphans(testRepo)
	if err == nil {
		t.Error("Expected error for non-existent git repo, got nil")
	}
}

func TestDetectOrphansCorruptedState(t *testing.T) {
	tmpDir := t.TempDir()
	stateStore := state.NewStore(tmpDir)
	gitClient := git.NewClient()

	detector := NewOrphanDetector(gitClient, stateStore)

	testRepo := &repo.Repo{
		Name: "test-repo",
		Path: tmpDir,
	}

	// Create corrupted state file
	stateFile := filepath.Join(tmpDir, ".swarm-state.json")
	if err := os.WriteFile(stateFile, []byte("invalid json{"), 0644); err != nil {
		t.Fatalf("Failed to write corrupted state: %v", err)
	}

	// Should return error when state is corrupted
	_, err := detector.DetectOrphans(testRepo)
	if err == nil {
		t.Error("Expected error for corrupted state, got nil")
	}
}
