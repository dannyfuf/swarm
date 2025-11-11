package safety

import "time"

// CheckResult represents safety check outcome
type CheckResult struct {
	Safe     bool
	Warnings []Warning
	Blockers []Blocker
	Metadata CheckMetadata
}

// Blocker prevents operation from proceeding
type Blocker struct {
	Type    BlockerType
	Message string
	Details string // Additional context
	Fix     string // Suggested fix
}

type BlockerType string

const (
	BlockerUncommittedChanges BlockerType = "uncommitted_changes"
	BlockerUnstagedChanges    BlockerType = "unstaged_changes"
)

// Warning doesn't prevent operation but should be noted
type Warning struct {
	Type    WarningType
	Message string
	Details string
}

type WarningType string

const (
	WarningUnpushedCommits WarningType = "unpushed_commits"
	WarningBranchNotMerged WarningType = "branch_not_merged"
	WarningOrphanedState   WarningType = "orphaned_state"
)

// CheckMetadata provides additional context
type CheckMetadata struct {
	CheckedAt        time.Time
	UncommittedFiles int
	UnpushedCommits  int
	BranchMerged     *bool // nil = unknown
}
