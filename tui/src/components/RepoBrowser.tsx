/**
 * RepoBrowser component - full-screen overlay for browsing and cloning GitHub repos.
 *
 * Handles its own keyboard: Tab to switch focus, Enter to clone, Esc to close.
 */

import type { SelectOption } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import { useCallback, useMemo, useRef, useState } from "react"
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
      backgroundColor="#000000"
    >
      <box
        border
        borderStyle="rounded"
        borderColor="#6366F1"
        width={70}
        flexDirection="column"
        paddingX={2}
        paddingY={1}
      >
        <text>
          <span fg="#6366F1">
            <strong>Download Repository</strong>
          </span>
        </text>

        <box marginTop={1} flexDirection="row" gap={1}>
          <text fg="#888888">Search:</text>
          <input
            value={filter}
            onChange={setFilter}
            placeholder="owner/repo"
            focused={inputFocused}
            width={50}
            backgroundColor="#1a1a2e"
            textColor="#FFFFFF"
            focusedBackgroundColor="#2a2a4e"
          />
        </box>

        <box marginTop={1} flexGrow={1} height={15}>
          {loading ? (
            <box flexDirection="row" gap={1}>
              <Spinner frame={frame} />
              <text fg="#888888">Loading repositories...</text>
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

        {filteredRepos.length === 0 && !loading && (
          <box marginTop={1}>
            <text fg="#888888">
              {filter ? "No matching repositories found" : "No repositories available"}
            </text>
          </box>
        )}

        <box marginTop={1} flexDirection="row" justifyContent="flex-end" gap={2}>
          <text fg="#888888">[Esc] Close</text>
          <text fg="#888888">[Tab] Switch focus</text>
          <text fg="#00FF00">[Enter] Clone</text>
        </box>
      </box>
    </box>
  )
}

function formatRepoEntry(r: BrowsableRepo): string {
  const badge =
    r.availability === "installed"
      ? " [INSTALLED]"
      : r.availability === "cloning"
        ? " [CLONING...]"
        : ""

  return `${r.remote.fullName}${badge}`
}
