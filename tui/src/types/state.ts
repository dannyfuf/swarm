/**
 * State persistence types for Swarm TUI.
 *
 * Mirrors the Go `internal/state/types.go` structs.
 * Defines the JSON schema for `.swarm-state.json`, ensuring backward
 * compatibility with the Go version.
 */

import type { WorktreeContainerMetadata } from "./container.js"

/** Top-level state object persisted to `.swarm-state.json`. */
export interface State {
  /** Schema version for forward-compatibility checks. */
  version: number
  /** Timestamp of last state file write. */
  updatedAt: Date
  /** Per-repository state keyed by repo name. */
  repos: Record<string, RepoState>
}

/** Persisted state for a single repository. */
export interface RepoState {
  path: string
  defaultBranch: string
  lastScanned: Date
  /** Worktree state entries keyed by slug. */
  worktrees: Record<string, WorktreeState>
}

/** Persisted state for a single worktree. */
export interface WorktreeState {
  slug: string
  branch: string
  path: string
  createdAt: Date
  lastOpenedAt: Date
  tmuxSession: string
  container?: WorktreeContainerMetadata
}
