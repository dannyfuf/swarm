/**
 * WorktreeList component - scrollable list of worktrees with status badges.
 *
 * Shows `[GONE]` tag for orphaned worktrees. Uses OpenTUI `<select>` for navigation.
 */

import type { SelectOption } from "@opentui/core"
import { useMemo } from "react"
import type { Status } from "../types/status.js"
import { getBadges } from "../types/status.js"
import type { Worktree } from "../types/worktree.js"

interface WorktreeListProps {
  worktrees: Worktree[]
  statuses: Map<string, Status>
  selectedIndex: number
  focused: boolean
  onSelect: (index: number, option: SelectOption | null) => void
  onChange: (index: number, option: SelectOption | null) => void
}

function formatWorktreeName(wt: Worktree, status: Status | undefined): string {
  let name = wt.branch || wt.slug

  if (wt.isOrphaned) {
    name = `${name} [GONE]`
  }

  if (status) {
    const badges = getBadges(status)
    if (badges.length > 0) {
      const badgeStr = badges.map((b) => b.symbol).join("")
      name = `${name} ${badgeStr}`
    }
  }

  return name
}

export function WorktreeList({
  worktrees,
  statuses,
  selectedIndex,
  focused,
  onSelect,
  onChange,
}: WorktreeListProps) {
  const options = useMemo(
    () =>
      worktrees.map((wt) => ({
        name: formatWorktreeName(wt, statuses.get(wt.path)),
        description: wt.slug,
        value: wt,
      })),
    [worktrees, statuses],
  )

  if (worktrees.length === 0) {
    return (
      <text fg="#888888">
        <em>No worktrees</em>
      </text>
    )
  }

  return (
    <select
      options={options}
      selectedIndex={selectedIndex}
      focused={focused}
      onChange={onChange}
      onSelect={onSelect}
      showScrollIndicator
      style={{ flexGrow: 1 }}
    />
  )
}
