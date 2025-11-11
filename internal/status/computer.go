package status

import (
	"fmt"
	"runtime"
	"sync"
	"time"

	"github.com/microsoft/amplifier/swarm/internal/git"
	"github.com/microsoft/amplifier/swarm/internal/worktree"
)

// ComputeOptions contains parameters for status computation
type ComputeOptions struct {
	RepoPath      string
	DefaultBranch string
}

// Compute calculates status for a worktree with caching
func (c *Computer) Compute(gitClient *git.Client, wt *worktree.Worktree, opts ComputeOptions) (*Status, error) {
	// Check cache first
	c.cacheMutex.RLock()
	cached, exists := c.cache[wt.Path]
	c.cacheMutex.RUnlock()

	if exists && time.Since(cached.computedAt) < c.ttl {
		return cached, nil
	}

	// Compute fresh status
	status := &Status{
		computedAt: time.Now(),
		ttl:        c.ttl,
	}

	// Check for changes
	gitStatus, err := gitClient.Status(wt.Path)
	if err != nil {
		return nil, fmt.Errorf("getting git status: %w", err)
	}

	totalChanges := len(gitStatus.Modified) + len(gitStatus.Added) +
		len(gitStatus.Deleted) + len(gitStatus.Untracked)
	status.HasChanges = totalChanges > 0

	// Check for unpushed commits
	unpushed, err := gitClient.UnpushedCommits(wt.Path, wt.Branch)
	if err == nil {
		status.HasUnpushed = len(unpushed) > 0
	}

	// Check if merged (optional, slow - only if TTL is large enough)
	if c.ttl > 5*time.Minute && opts.DefaultBranch != "" {
		merged, err := gitClient.IsMerged(opts.RepoPath, wt.Branch, opts.DefaultBranch)
		if err == nil {
			status.BranchMerged = &merged
		}
	}

	// Update cache
	c.cacheMutex.Lock()
	c.cache[wt.Path] = status
	c.cacheMutex.Unlock()

	return status, nil
}

// WorktreeWithOptions pairs a worktree with its computation options
type WorktreeWithOptions struct {
	Worktree *worktree.Worktree
	Options  ComputeOptions
}

// ComputeAll computes status for multiple worktrees in parallel
func (c *Computer) ComputeAll(gitClient *git.Client, items []WorktreeWithOptions) map[string]*Status {
	results := make(map[string]*Status)
	var mutex sync.Mutex
	var wg sync.WaitGroup

	// Worker pool
	jobs := make(chan WorktreeWithOptions, len(items))
	workers := min(runtime.NumCPU(), 4) // Limit to 4 workers

	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for item := range jobs {
				status, err := c.Compute(gitClient, item.Worktree, item.Options)
				if err == nil {
					mutex.Lock()
					results[item.Worktree.Path] = status
					mutex.Unlock()
				}
			}
		}()
	}

	// Distribute work
	for _, item := range items {
		jobs <- item
	}
	close(jobs)

	wg.Wait()
	return results
}

// InvalidateCache clears cached status for a specific worktree
func (c *Computer) InvalidateCache(path string) {
	c.cacheMutex.Lock()
	delete(c.cache, path)
	c.cacheMutex.Unlock()
}

// ClearCache clears all cached status
func (c *Computer) ClearCache() {
	c.cacheMutex.Lock()
	c.cache = make(map[string]*Status)
	c.cacheMutex.Unlock()
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
