/**
 * StatusBar component - bottom bar with structured key badges and messages.
 *
 * Three zones: mode indicator (left), status message (center), shortcut badges (right).
 * Shows error messages (red), status messages (green/yellow), and
 * context-sensitive keyboard shortcut hints as styled badges.
 */

import { memo } from "react"
import type { Panel } from "../state/actions.js"
import { colors } from "../theme.js"

interface StatusBarProps {
  focusedPanel: Panel
  errorMessage: string
  statusMessage: string
  inputMode: string
  showDialog: boolean
  activeOperationCount?: number
}

interface KeyHint {
  key: string
  action: string
}

function KeyBadge({ keyName, action }: { keyName: string; action: string }) {
  return (
    <text>
      <span fg={colors.accent} bg={colors.bgHighlight}>
        {` ${keyName} `}
      </span>
      <span fg={colors.textSecondary}>{` ${action}`}</span>
    </text>
  )
}

export const StatusBar = memo(function StatusBar({
  focusedPanel,
  errorMessage,
  statusMessage,
  inputMode,
  showDialog,
  activeOperationCount = 0,
}: StatusBarProps) {
  // Error takes priority — full-width red message
  if (errorMessage) {
    return (
      <box height={1} paddingX={1} flexDirection="row">
        <text>
          <span fg={colors.error}>{errorMessage}</span>
        </text>
      </box>
    )
  }

  // Status message — green or yellow
  if (statusMessage) {
    const msgColor = statusMessage.includes("Warning:") ? colors.warning : colors.success
    return (
      <box height={1} paddingX={1} flexDirection="row">
        <text>
          <span fg={msgColor}>{statusMessage}</span>
        </text>
        {activeOperationCount > 0 ? (
          <box marginLeft={1}>
            <text>
              <span fg={colors.textMuted}>{formatActivitySummary(activeOperationCount)}</span>
            </text>
          </box>
        ) : null}
      </box>
    )
  }

  // Dialog mode hints
  if (showDialog) {
    return (
      <box height={1} paddingX={1} flexDirection="row" gap={2}>
        <KeyBadge keyName="Enter" action="confirm" />
        <KeyBadge keyName="Esc" action="cancel" />
        {activeOperationCount > 0 ? (
          <text>
            <span fg={colors.textMuted}>{formatActivitySummary(activeOperationCount)}</span>
          </text>
        ) : null}
      </box>
    )
  }

  // Input mode hints
  if (inputMode === "create" || inputMode === "createAndStart") {
    const action = inputMode === "createAndStart" ? "create + start" : "create"
    return (
      <box height={1} paddingX={1} flexDirection="row" gap={2}>
        <KeyBadge keyName="Enter" action={action} />
        <KeyBadge keyName="Esc" action="cancel" />
        {activeOperationCount > 0 ? (
          <text>
            <span fg={colors.textMuted}>{formatActivitySummary(activeOperationCount)}</span>
          </text>
        ) : null}
      </box>
    )
  }

  // Context-sensitive key hints
  const hints = getKeyHints(focusedPanel)

  return (
    <box height={1} paddingX={1} flexDirection="row" gap={1}>
      {/* Left: mode indicator */}
      <text>
        <span fg={colors.accent}>{"❯"}</span>
        <span fg={colors.textPrimary}>{` ${focusedPanel}`}</span>
      </text>
      <text>
        <span fg={colors.borderDefault}>{"│"}</span>
      </text>
      {/* Center/right: key badges */}
      {hints.map((hint) => (
        <KeyBadge key={hint.key} keyName={hint.key} action={hint.action} />
      ))}
      {activeOperationCount > 0 ? (
        <text>
          <span fg={colors.textMuted}>
            {"│ "}
            {formatActivitySummary(activeOperationCount)}
          </span>
        </text>
      ) : null}
    </box>
  )
})

function formatActivitySummary(activeOperationCount: number): string {
  return `${activeOperationCount} task${activeOperationCount === 1 ? "" : "s"} running`
}

function getKeyHints(panel: Panel): KeyHint[] {
  switch (panel) {
    case "repos":
      return [
        { key: "Tab", action: "switch" },
        { key: "Enter", action: "select" },
        { key: "c", action: "copy" },
        { key: "f", action: "fetch" },
        { key: "?", action: "help" },
      ]
    case "worktrees":
      return [
        { key: "Tab", action: "switch" },
        { key: "n", action: "new" },
        { key: "o", action: "open" },
        { key: "d", action: "delete" },
        { key: "s", action: "start" },
        { key: "?", action: "help" },
      ]
    case "detail":
      return [
        { key: "Tab", action: "switch" },
        { key: "s", action: "start" },
        { key: "x", action: "stop" },
        { key: "v", action: "inspect" },
        { key: "?", action: "help" },
      ]
  }
}
