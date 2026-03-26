/**
 * StatusBar component - bottom bar with key hints and messages.
 *
 * Shows error messages (red), status messages (green), and
 * context-sensitive keyboard shortcut hints.
 */

import type { Panel } from "../state/actions.js"

interface StatusBarProps {
  focusedPanel: Panel
  errorMessage: string
  statusMessage: string
  inputMode: string
  showDialog: boolean
  activeOperationCount?: number
}

export function StatusBar({
  focusedPanel,
  errorMessage,
  statusMessage,
  inputMode,
  showDialog,
  activeOperationCount = 0,
}: StatusBarProps) {
  // Error takes priority
  if (errorMessage) {
    return (
      <box height={1} paddingX={1}>
        <text fg="#FF0000">{errorMessage}</text>
      </box>
    )
  }

  // Status message
  if (statusMessage) {
    return (
      <box height={1} paddingX={1}>
        <text fg={statusMessage.includes("Warning:") ? "#FFFF00" : "#00FF00"}>{statusMessage}</text>
      </box>
    )
  }

  // Dialog mode hints
  if (showDialog) {
    return (
      <box height={1} paddingX={1}>
        <text fg="#888888">
          {appendActivitySummary("Enter: confirm | Esc: cancel", activeOperationCount)}
        </text>
      </box>
    )
  }

  // Input mode hints
  if (inputMode === "create" || inputMode === "createAndStart") {
    return (
      <box height={1} paddingX={1}>
        <text fg="#888888">
          {appendActivitySummary(
            inputMode === "createAndStart"
              ? "Enter: create + start | Esc: cancel"
              : "Enter: create | Esc: cancel",
            activeOperationCount,
          )}
        </text>
      </box>
    )
  }

  // Context-sensitive key hints
  const hints = getKeyHints(focusedPanel)
  return (
    <box height={1} paddingX={1}>
      <text fg="#888888">{appendActivitySummary(hints, activeOperationCount)}</text>
    </box>
  )
}

function appendActivitySummary(message: string, activeOperationCount: number): string {
  if (activeOperationCount === 0) {
    return message
  }

  return `${message} | ${formatActivitySummary(activeOperationCount)}`
}

function formatActivitySummary(activeOperationCount: number): string {
  return `${activeOperationCount} task${activeOperationCount === 1 ? "" : "s"} running...`
}

function getKeyHints(panel: Panel): string {
  const common = "q: quit | Tab: switch panel | f: fetch repo | ?: help"

  switch (panel) {
    case "repos":
      return `j/k: navigate | c: copy path | y: copy config path | ${common}`
    case "worktrees":
      return `j/k: navigate | n/N: new | s: start | x: stop | i: build | g: config | y: copy config path | o: open | d: delete | v: inspect | r: refresh | p: prune | c: copy path | b: copy branch | ${common}`
    case "detail":
      return `s: start | x: stop | i: build | g: config | y: copy config path | v: inspect | ${common}`
  }
}
