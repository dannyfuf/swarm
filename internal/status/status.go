package status

import (
	"sync"
	"time"
)

// Status represents computed worktree status
type Status struct {
	HasChanges   bool
	HasUnpushed  bool
	BranchMerged *bool // nil = unknown
	IsOrphaned   bool

	// Cached data
	computedAt time.Time
	ttl        time.Duration
}

// Computer computes status with caching
type Computer struct {
	cache      map[string]*Status // key: worktree path
	cacheMutex sync.RWMutex
	ttl        time.Duration
}

// NewComputer creates a new status computer with specified cache TTL
func NewComputer(ttl time.Duration) *Computer {
	return &Computer{
		cache: make(map[string]*Status),
		ttl:   ttl,
	}
}
