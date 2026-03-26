/**
 * Safety check types for Swarm TUI.
 *
 * Mirrors the Go `internal/safety/safety.go` structs.
 * Separates blockers (prevent action) from warnings (allow with confirmation).
 */

/** Types of conditions that block worktree removal. */
export type BlockerType = "uncommitted_changes" | "unstaged_changes"

/** Types of conditions that warn before worktree removal. */
export type WarningType = "unpushed_commits" | "branch_not_merged" | "orphaned_state"

/** A condition that prevents worktree removal. */
export interface Blocker {
  type: BlockerType
  message: string
  details: string
  fix: string
}

/** A condition that warns before worktree removal but does not block. */
export interface Warning {
  type: WarningType
  message: string
  details: string
}

/** Metadata collected during a safety check. */
export interface CheckMetadata {
  checkedAt: Date
  uncommittedFiles: number
  unpushedCommits: number
  branchMerged: boolean | null
}

/** Result of running safety checks on a worktree before removal. */
export interface CheckResult {
  /** Whether it is safe to proceed without confirmation. */
  safe: boolean
  warnings: Warning[]
  blockers: Blocker[]
  metadata: CheckMetadata
}

/** Result of checking whether a branch is safe to delete. */
export interface BranchSafetyResult {
  safe: boolean
  warnings: string[]
  blockers: string[]
  commitCount: number
  unpushedCount: number
  isMerged: boolean
}
