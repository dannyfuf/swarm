/**
 * HelpDialog component - displays keyboard shortcut reference.
 *
 * Handles its own keyboard: Esc or Enter to close.
 */

import { useKeyboard } from "@opentui/react"

interface HelpDialogProps {
  onClose: () => void
}

const SHORTCUTS = [
  { key: "j / k / Up / Down", action: "Navigate list" },
  { key: "Tab / Shift+Tab", action: "Switch panel" },
  { key: "Enter", action: "Select / Confirm" },
  { key: "n", action: "New worktree" },
  { key: "o", action: "Open in tmux" },
  { key: "d", action: "Delete worktree" },
  { key: "r", action: "Refresh" },
  { key: "p", action: "Prune orphans" },
  { key: "c", action: "Copy path" },
  { key: "b", action: "Copy branch name" },
  { key: "?", action: "Show help" },
  { key: "q / Ctrl+C", action: "Quit" },
]

export function HelpDialog({ onClose }: HelpDialogProps) {
  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "enter" || key.name === "return") {
      onClose()
    }
  })

  return (
    <box justifyContent="center" alignItems="center" width="100%" height="100%">
      <box
        border
        borderStyle="rounded"
        borderColor="#6366F1"
        width={50}
        flexDirection="column"
        paddingX={2}
        paddingY={1}
      >
        <text>
          <span fg="#6366F1">
            <strong>Keyboard Shortcuts</strong>
          </span>
        </text>
        <box marginTop={1} flexDirection="column">
          {SHORTCUTS.map((shortcut) => (
            <box key={shortcut.key} flexDirection="row">
              <box width={22}>
                <text fg="#FFFF00">{shortcut.key}</text>
              </box>
              <text>{shortcut.action}</text>
            </box>
          ))}
        </box>
        <box marginTop={1} flexDirection="row" justifyContent="flex-end">
          <text fg="#00FF00">[Esc / Enter] Close</text>
        </box>
      </box>
    </box>
  )
}
