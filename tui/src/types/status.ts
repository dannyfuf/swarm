/**
 * Status and badge types for Swarm TUI.
 *
 * Mirrors the Go `internal/status/status.go` and `internal/status/badge.go` structs.
 * Represents computed worktree health and the visual badges shown in the list.
 */

/** Computed health status for a worktree (TTL-cached). */
export interface Status {
  hasChanges: boolean
  hasUnpushed: boolean
  branchMerged: boolean | null
  isOrphaned: boolean
  /** When this status was computed (for TTL expiry). */
  computedAt: Date
}

/** A visual badge displayed next to a worktree in the list. */
export interface Badge {
  /** Single-character symbol (e.g. "●", "↑", "✓", "⚠"). */
  symbol: string
  /** ANSI/hex color for rendering. */
  color: string
  /** Tooltip hint describing the badge meaning. */
  hint: string
}

/**
 * Returns the ordered list of badges for a given status.
 * Badge order matches the Go implementation:
 * 1. Uncommitted changes (yellow ●)
 * 2. Unpushed commits (cyan ↑)
 * 3. Merged (green ✓)
 * 4. Orphaned (red ⚠)
 */
export function getBadges(status: Status): Badge[] {
  const badges: Badge[] = []

  if (status.hasChanges) {
    badges.push({ symbol: "●", color: "#FFFF00", hint: "uncommitted changes" })
  }
  if (status.hasUnpushed) {
    badges.push({ symbol: "↑", color: "#00FFFF", hint: "unpushed commits" })
  }
  if (status.branchMerged === true) {
    badges.push({ symbol: "✓", color: "#00FF00", hint: "merged" })
  }
  if (status.isOrphaned) {
    badges.push({ symbol: "⚠", color: "#FF0000", hint: "orphaned" })
  }

  return badges
}
