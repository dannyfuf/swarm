/**
 * WorktreeList component - scrollable list of worktrees with status badges.
 *
 * Shows `✗ gone` tag for orphaned worktrees. Uses Unicode badge symbols
 * from theme for container and git status indicators.
 */

import type { SelectOption } from "@opentui/core"
import { memo, useMemo } from "react"
import { badgeSymbols, colors } from "../theme.js"
import type { ContainerRuntimeStatus } from "../types/container.js"
import type { Status } from "../types/status.js"
import { getBadges } from "../types/status.js"
import type { Worktree } from "../types/worktree.js"

interface WorktreeListProps {
  worktrees: Worktree[]
  statuses: Map<string, Status>
  containerStatuses: Map<string, ContainerRuntimeStatus>
  selectedIndex: number
  focused: boolean
  onSelect: (index: number, option: SelectOption | null) => void
  onChange: (index: number, option: SelectOption | null) => void
}

function formatWorktreeName(
  wt: Worktree,
  status: Status | undefined,
  containerStatus: ContainerRuntimeStatus | undefined,
): string {
  let name = wt.branch || wt.slug

  if (wt.isOrphaned) {
    name = `${name}  ${badgeSymbols.orphaned} gone`
  }

  if (status) {
    const badges = getBadges(status)
    if (badges.length > 0) {
      name = `${name}  ${badges.map((b) => b.symbol).join(" ")}`
    }
  }

  if (containerStatus) {
    const symbol = getContainerSymbol(containerStatus.state)
    name = `${name}  ${symbol}`
  }

  return name
}

function getContainerSymbol(state: string): string {
  switch (state) {
    case "running":
      return badgeSymbols.containerUp
    case "stopped":
      return badgeSymbols.containerDown
    case "failed":
      return badgeSymbols.containerFail
    case "not-created":
      return badgeSymbols.containerNone
    default:
      return "?"
  }
}

export const WorktreeList = memo(function WorktreeList({
  worktrees,
  statuses,
  containerStatuses,
  selectedIndex,
  focused,
  onSelect,
  onChange,
}: WorktreeListProps) {
  const options = useMemo(
    () =>
      worktrees.map((wt) => ({
        name: formatWorktreeName(wt, statuses.get(wt.path), containerStatuses.get(wt.path)),
        description: wt.slug,
        value: wt,
      })),
    [worktrees, statuses, containerStatuses],
  )

  if (worktrees.length === 0) {
    return (
      <text>
        <span fg={colors.textMuted}>
          <em>No worktrees</em>
        </span>
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
})
