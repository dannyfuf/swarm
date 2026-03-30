/**
 * Worktree types for Swarm TUI.
 *
 * Mirrors the Go `internal/worktree/types.go` structs.
 * Represents managed worktrees and their lifecycle metadata.
 */

import type { WorktreeContainerMetadata } from "./container.js"

/** A managed git worktree with state metadata. */
export interface Worktree {
  /** Filesystem-safe slug derived from the branch name. */
  slug: string
  /** Git branch name checked out in this worktree. */
  branch: string
  /** Absolute filesystem path to the worktree directory. */
  path: string
  /** Name of the parent repository. */
  repoName: string
  /** When this worktree was created. */
  createdAt: Date
  /** When this worktree was last opened in tmux. */
  lastOpenedAt: Date
  /** Associated tmux session name (format: `<repo>--wt--<slug>`). */
  tmuxSession: string
  /** Stable container metadata persisted in Swarm state. */
  container?: WorktreeContainerMetadata
  /** Whether this worktree is orphaned (exists in state but not on disk). */
  isOrphaned: boolean
}

/** Options for creating a new worktree. */
export interface CreateOptions {
  /** Branch name to check out or create. */
  branch: string
  /** Base branch for new branch creation. */
  baseBranch: string
  /** Whether the branch should be newly created. */
  newBranch: boolean
}

/** An orphaned worktree detected during pruning. */
export interface OrphanedWorktree {
  slug: string
  branch: string
  path: string
  /** Why this worktree is considered orphaned. */
  reason: string
  createdAt: Date
}
