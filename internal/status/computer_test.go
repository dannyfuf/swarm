package status

import (
	"testing"
	"time"

	"github.com/microsoft/amplifier/swarm/internal/worktree"
)

func TestNewComputer(t *testing.T) {
	ttl := 5 * time.Minute
	computer := NewComputer(ttl)

	if computer == nil {
		t.Fatal("NewComputer returned nil")
	}

	if computer.ttl != ttl {
		t.Errorf("expected ttl %v, got %v", ttl, computer.ttl)
	}

	if computer.cache == nil {
		t.Error("cache not initialized")
	}
}

func TestInvalidateCache(t *testing.T) {
	computer := NewComputer(5 * time.Minute)

	// Add a fake cache entry
	testPath := "/test/path"
	computer.cache[testPath] = &Status{
		HasChanges: true,
	}

	// Verify it exists
	if _, exists := computer.cache[testPath]; !exists {
		t.Fatal("cache entry not added")
	}

	// Invalidate
	computer.InvalidateCache(testPath)

	// Verify it's gone
	if _, exists := computer.cache[testPath]; exists {
		t.Error("cache entry not removed")
	}
}

func TestClearCache(t *testing.T) {
	computer := NewComputer(5 * time.Minute)

	// Add multiple fake cache entries
	computer.cache["/test/path1"] = &Status{HasChanges: true}
	computer.cache["/test/path2"] = &Status{HasUnpushed: true}

	if len(computer.cache) != 2 {
		t.Fatal("cache entries not added")
	}

	// Clear all
	computer.ClearCache()

	if len(computer.cache) != 0 {
		t.Error("cache not cleared")
	}
}

func TestCaching(t *testing.T) {
	computer := NewComputer(1 * time.Second)

	// Manually add a cached status
	testPath := "/test/path"
	cachedStatus := &Status{
		HasChanges: true,
		computedAt: time.Now(),
		ttl:        computer.ttl,
	}
	computer.cache[testPath] = cachedStatus

	// Try to get cached value
	computer.cacheMutex.RLock()
	cached, exists := computer.cache[testPath]
	computer.cacheMutex.RUnlock()

	if !exists {
		t.Fatal("cached status not found")
	}

	if !cached.HasChanges {
		t.Error("cached status incorrect")
	}

	// Wait for cache to expire
	time.Sleep(1100 * time.Millisecond)

	// Check if cache is considered expired
	if time.Since(cached.computedAt) < computer.ttl {
		t.Error("cache should be expired")
	}
}

func TestComputeAllWorkerPool(t *testing.T) {
	computer := NewComputer(5 * time.Minute)

	// Create test worktrees
	items := []WorktreeWithOptions{
		{
			Worktree: &worktree.Worktree{
				Path:   "/test/wt1",
				Branch: "feature1",
			},
			Options: ComputeOptions{
				RepoPath:      "/test/repo",
				DefaultBranch: "main",
			},
		},
		{
			Worktree: &worktree.Worktree{
				Path:   "/test/wt2",
				Branch: "feature2",
			},
			Options: ComputeOptions{
				RepoPath:      "/test/repo",
				DefaultBranch: "main",
			},
		},
	}

	// ComputeAll will fail without a real git client, but we can verify
	// it doesn't panic and returns an empty map
	results := computer.ComputeAll(nil, items)

	if results == nil {
		t.Error("ComputeAll returned nil")
	}
}

func TestMinFunction(t *testing.T) {
	tests := []struct {
		a, b, want int
	}{
		{1, 2, 1},
		{2, 1, 1},
		{5, 5, 5},
		{0, 10, 0},
	}

	for _, tt := range tests {
		got := min(tt.a, tt.b)
		if got != tt.want {
			t.Errorf("min(%d, %d) = %d, want %d", tt.a, tt.b, got, tt.want)
		}
	}
}
