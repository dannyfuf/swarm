/**
 * Repository types for Swarm TUI.
 *
 * Mirrors the Go `internal/repo/types.go` Repo struct.
 * Represents a discovered git repository managed by Swarm.
 */

/** A discovered git repository in the AI working directory. */
export interface Repo {
  /** Human-readable name derived from the directory name. */
  name: string
  /** Absolute filesystem path to the repository root. */
  path: string
  /** Default branch (e.g. "main", "master"). */
  defaultBranch: string
  /** When this repository was last scanned for worktrees. */
  lastScanned: Date
}
