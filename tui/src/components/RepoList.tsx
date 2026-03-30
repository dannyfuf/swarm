/**
 * RepoList component - scrollable list of discovered repositories.
 *
 * Uses OpenTUI's `<select>` for keyboard navigation (j/k/up/down).
 */

import type { SelectOption } from "@opentui/core"
import { memo, useMemo } from "react"
import { colors } from "../theme.js"
import type { Repo } from "../types/repo.js"

interface RepoListProps {
  repos: Repo[]
  selectedIndex: number
  focused: boolean
  onSelect: (index: number, option: SelectOption | null) => void
  onChange: (index: number, option: SelectOption | null) => void
}

export const RepoList = memo(function RepoList({
  repos,
  selectedIndex,
  focused,
  onSelect,
  onChange,
}: RepoListProps) {
  const options = useMemo(
    () =>
      repos.map((r) => ({
        name: r.name,
        description: r.path,
        value: r,
      })),
    [repos],
  )

  if (repos.length === 0) {
    return (
      <text>
        <span fg={colors.textMuted}>
          <em>No repositories found</em>
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
