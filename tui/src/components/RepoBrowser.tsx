/**
 * RepoBrowser component - full-screen overlay for browsing and cloning GitHub repos.
 *
 * Handles its own keyboard: Tab to switch focus, Enter to clone, Esc to close.
 * Uses theme colors and styled availability badges.
 */

import type { SelectOption } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import { useCallback, useMemo, useRef, useState } from "react"
import { badgeSymbols, borders, colors, spacing } from "../theme.js"
import type { BrowsableRepo, RemoteRepo } from "../types/github.js"
import { Spinner, useSpinnerFrame } from "./Spinner.js"

interface RepoBrowserProps {
  repos: BrowsableRepo[]
  loading: boolean
  onClone: (repo: RemoteRepo) => void
  onClose: () => void
}

export function RepoBrowser({ repos, loading, onClone, onClose }: RepoBrowserProps) {
  const [filter, setFilter] = useState("")
  const [inputFocused, setInputFocused] = useState(true)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const frame = useSpinnerFrame()
  const clonedRef = useRef(false)

  const filteredRepos = useMemo(() => {
    const query = filter.toLowerCase()
    const filtered = repos.filter((r) => {
      if (!query) return true
      return (
        r.remote.fullName.toLowerCase().includes(query) ||
        r.remote.description.toLowerCase().includes(query)
      )
    })

    return filtered.sort((a, b) => {
      const aOrder = a.availability === "available" ? 0 : a.availability === "cloning" ? 1 : 2
      const bOrder = b.availability === "available" ? 0 : b.availability === "cloning" ? 1 : 2
      if (aOrder !== bOrder) return aOrder - bOrder
      return a.remote.fullName.localeCompare(b.remote.fullName)
    })
  }, [repos, filter])

  const handleClone = useCallback(
    (repo: BrowsableRepo) => {
      if (clonedRef.current) return
      if (repo.availability !== "available") return
      clonedRef.current = true
      onClone(repo.remote)
    },
    [onClone],
  )

  useKeyboard((key) => {
    if (key.name === "escape") {
      key.stopPropagation()
      onClose()
      return
    }

    if (key.name === "tab") {
      key.stopPropagation()
      setInputFocused((v) => !v)
      return
    }

    if (key.name === "/" && !inputFocused) {
      key.stopPropagation()
      setInputFocused(true)
      return
    }

    if (!inputFocused && (key.name === "enter" || key.name === "return")) {
      key.stopPropagation()
      const selected = filteredRepos[selectedIndex]
      if (selected) {
        handleClone(selected)
      }
    }
  })

  const selectOptions: SelectOption[] = useMemo(
    () =>
      filteredRepos.map((r) => ({
        name: formatRepoEntry(r),
        description: r.remote.description || r.remote.fullName,
        value: r,
      })),
    [filteredRepos],
  )

  return (
    <box
      justifyContent="center"
      alignItems="center"
      width="100%"
      height="100%"
      backgroundColor={colors.bg}
    >
      <box
        border
        borderStyle={borders.dialog}
        borderColor={colors.borderFocused}
        width={spacing.repoBrowserWidth}
        flexDirection="column"
        paddingX={spacing.dialogPaddingX}
        paddingY={spacing.dialogPaddingY}
      >
        <text>
          <span fg={colors.accent}>
            <strong>Clone Repository</strong>
          </span>
        </text>

        <box marginTop={1} flexDirection="row" gap={1}>
          <text>
            <span fg={colors.textSecondary}>Search:</span>
          </text>
          <input
            value={filter}
            onChange={setFilter}
            placeholder="owner/repo"
            focused={inputFocused}
            width={spacing.repoBrowserWidth - spacing.dialogPaddingX * 2 - 12}
            backgroundColor={colors.bgSurface}
            textColor={colors.textPrimary}
            focusedBackgroundColor={colors.bgOverlay}
          />
        </box>

        <box marginTop={1} flexGrow={1} height={15}>
          {loading ? (
            <box flexDirection="row" gap={1}>
              <Spinner frame={frame} />
              <text>
                <span fg={colors.textSecondary}>Loading repositories...</span>
              </text>
            </box>
          ) : (
            <select
              options={selectOptions}
              focused={!inputFocused}
              height={15}
              selectedIndex={selectedIndex}
              onChange={(index) => {
                setSelectedIndex(index)
              }}
            />
          )}
        </box>

        {filteredRepos.length === 0 && !loading ? (
          <box marginTop={1}>
            <text>
              <span fg={colors.textMuted}>
                {filter ? "No matching repositories found" : "No repositories available"}
              </span>
            </text>
          </box>
        ) : null}

        <box marginTop={1} flexDirection="row" justifyContent="flex-end" gap={2}>
          <text>
            <span fg={colors.accent} bg={colors.bgHighlight}>
              {" Esc "}
            </span>
            <span fg={colors.textSecondary}>{" Close"}</span>
          </text>
          <text>
            <span fg={colors.accent} bg={colors.bgHighlight}>
              {" Tab "}
            </span>
            <span fg={colors.textSecondary}>{" Switch"}</span>
          </text>
          <text>
            <span fg={colors.success} bg={colors.bgHighlight}>
              {" Enter "}
            </span>
            <span fg={colors.success}>{" Clone"}</span>
          </text>
        </box>
      </box>
    </box>
  )
}

function formatRepoEntry(r: BrowsableRepo): string {
  if (r.availability === "installed")
    return `${r.remote.fullName}  ${badgeSymbols.installed} installed`
  if (r.availability === "cloning") return `${r.remote.fullName}  ${badgeSymbols.cloning} cloning`
  return r.remote.fullName
}
