/**
 * DetailView component - shows full details for the selected worktree.
 *
 * Displays branch, slug, path, repo, status badges, and timestamps.
 */

import type { Status } from "../types/status.js"
import { getBadges } from "../types/status.js"
import type { Worktree } from "../types/worktree.js"

interface DetailViewProps {
  worktree: Worktree | null
  status: Status | undefined
}

function formatDate(date: Date): string {
  return date.toLocaleString()
}

export function DetailView({ worktree, status }: DetailViewProps) {
  if (!worktree) {
    return (
      <text fg="#888888">
        <em>Select a worktree to view details</em>
      </text>
    )
  }

  const badges = status ? getBadges(status) : []
  const badgeStr =
    badges.length > 0 ? badges.map((b) => `${b.symbol} ${b.hint}`).join("  ") : "none"

  return (
    <box flexDirection="column" gap={1}>
      <text>
        <span fg="#6366F1">
          <strong>Branch:</strong>
        </span>{" "}
        {worktree.branch}
      </text>
      <text>
        <span fg="#6366F1">
          <strong>Slug:</strong>
        </span>{" "}
        {worktree.slug}
      </text>
      <text>
        <span fg="#6366F1">
          <strong>Path:</strong>
        </span>{" "}
        {worktree.path}
      </text>
      <text>
        <span fg="#6366F1">
          <strong>Repo:</strong>
        </span>{" "}
        {worktree.repoName}
      </text>
      <text>
        <span fg="#6366F1">
          <strong>Session:</strong>
        </span>{" "}
        {worktree.tmuxSession}
      </text>
      <text>
        <span fg="#6366F1">
          <strong>Status:</strong>
        </span>{" "}
        {badgeStr}
      </text>
      {worktree.isOrphaned && (
        <text fg="#FF0000">
          <strong>ORPHANED</strong>
        </text>
      )}
      <text>
        <span fg="#6366F1">
          <strong>Created:</strong>
        </span>{" "}
        {formatDate(worktree.createdAt)}
      </text>
      <text>
        <span fg="#6366F1">
          <strong>Last Opened:</strong>
        </span>{" "}
        {formatDate(worktree.lastOpenedAt)}
      </text>
    </box>
  )
}
