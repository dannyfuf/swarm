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
}

export function StatusBar({
  focusedPanel,
  errorMessage,
  statusMessage,
  inputMode,
  showDialog,
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
        <text fg="#00FF00">{statusMessage}</text>
      </box>
    )
  }

  // Dialog mode hints
  if (showDialog) {
    return (
      <box height={1} paddingX={1}>
        <text fg="#888888">Enter: confirm | Esc: cancel</text>
      </box>
    )
  }

  // Input mode hints
  if (inputMode === "create") {
    return (
      <box height={1} paddingX={1}>
        <text fg="#888888">Enter: create | Esc: cancel</text>
      </box>
    )
  }

  // Context-sensitive key hints
  const hints = getKeyHints(focusedPanel)
  return (
    <box height={1} paddingX={1}>
      <text fg="#888888">{hints}</text>
    </box>
  )
}

function getKeyHints(panel: Panel): string {
  const common = "q: quit | Tab: switch panel | ?: help"

  switch (panel) {
    case "repos":
      return `j/k: navigate | c: copy path | ${common}`
    case "worktrees":
      return `j/k: navigate | n: new | o: open | d: delete | r: refresh | p: prune | c: copy path | b: copy branch | ${common}`
    case "detail":
      return common
  }
}
