/**
 * Configuration types for Swarm TUI.
 *
 * Mirrors the Go `internal/config/config.go` Config struct.
 * Defines how worktrees are laid out on disk, tmux integration options,
 * and status caching behavior.
 */

/** Supported worktree directory layout patterns. */
export type WorktreePattern = "patternA" | "patternB" | "patternC"

/**
 * Application-wide configuration loaded from YAML file, environment
 * variables, and built-in defaults (in ascending priority order).
 */
export interface Config {
  /** Root directory containing all managed repositories (e.g. ~/swarm/ai_working). */
  aiWorkingDir: string
  /** Default branch to base new worktrees on (e.g. "main"). */
  defaultBaseBranch: string
  /**
   * Worktree directory layout strategy:
   * - patternA: `<aiWorkingDir>/<repo>__wt__<slug>` (flat siblings)
   * - patternB: `<repoPath>/.worktrees/<slug>` (nested in repo)
   * - patternC: `<aiWorkingDir>/.worktrees/<repo>/<slug>` (centralized)
   */
  worktreePattern: WorktreePattern
  /** Automatically create a tmux session when a worktree is created. */
  createSessionOnCreate: boolean
  /** Path to a custom tmux layout script (shell or JSON). */
  tmuxLayoutScript: string
  /** How long computed worktree statuses remain cached, in milliseconds. */
  statusCacheTTL: number
  /** Prefer fzf for interactive selection (out of scope for TUI rewrite). */
  preferFzf: boolean
  /** Automatically prune orphaned state entries on worktree removal. */
  autoPruneOnRemove: boolean
  /** Start of the stable host port allocation range for worktree containers. */
  containerPortRangeStart: number
  /** End of the stable host port allocation range for worktree containers. */
  containerPortRangeEnd: number
}

/** Valid worktree pattern values for validation. */
export const VALID_WORKTREE_PATTERNS: ReadonlyArray<WorktreePattern> = [
  "patternA",
  "patternB",
  "patternC",
]
