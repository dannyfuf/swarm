/**
 * Git-related types for Swarm TUI.
 *
 * Mirrors the Go `internal/git/types.go` and `internal/git/branch.go` structs.
 * Represents raw git data returned by CLI parsing utilities.
 */

/** A single entry from `git worktree list --porcelain`. */
export interface WorktreeInfo {
  /** Absolute filesystem path to the worktree directory. */
  path: string
  /** Branch name (e.g. "refs/heads/feature/auth" or just "feature/auth"). */
  branch: string
  /** HEAD commit hash. */
  commit: string
  /** Whether the worktree is in detached HEAD state. */
  detached: boolean
}

/** Aggregated result from `git status --porcelain`. */
export interface StatusResult {
  modified: string[]
  added: string[]
  deleted: string[]
  untracked: string[]
}

/** A parsed git commit record. */
export interface Commit {
  hash: string
  message: string
  author: string
  date: Date
}

/** Options for `git worktree add`. */
export interface AddOptions {
  /** Filesystem path where the new worktree will be created. */
  path: string
  /** Branch name to check out or create. */
  branch: string
  /** Base branch for creating a new branch (empty string for existing branches). */
  baseBranch: string
  /** Whether to create a new branch (`-b`) or check out an existing one. */
  newBranch: boolean
}

/** Comprehensive information about a git branch. */
export interface BranchInfo {
  name: string
  exists: boolean
  hasCommits: boolean
  commitCount: number
  isMerged: boolean
  upstream: string
  lastCommit: Commit | null
}
