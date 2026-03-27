/**
 * HelpDialog component - displays keyboard shortcut reference.
 *
 * Organized into sections (Navigation, Worktree, Container, General).
 * Handles its own keyboard: Esc or Enter to close.
 */

import { useKeyboard } from "@opentui/react"
import { borders, colors, spacing } from "../theme.js"

interface HelpDialogProps {
  onClose: () => void
  title?: string
  message?: string
}

interface ShortcutEntry {
  key: string
  action: string
}

interface ShortcutSection {
  label: string
  shortcuts: ShortcutEntry[]
}

const SHORTCUT_SECTIONS: ShortcutSection[] = [
  {
    label: "Navigation",
    shortcuts: [
      { key: "j / k / Up / Down", action: "Navigate list" },
      { key: "Tab / Shift+Tab", action: "Switch panel" },
      { key: "Enter", action: "Select / Confirm" },
    ],
  },
  {
    label: "Worktree",
    shortcuts: [
      { key: "n", action: "New worktree" },
      { key: "N", action: "New worktree + start" },
      { key: "o", action: "Open in tmux" },
      { key: "d", action: "Delete worktree" },
    ],
  },
  {
    label: "Container",
    shortcuts: [
      { key: "s", action: "Start container" },
      { key: "x", action: "Stop container" },
      { key: "i", action: "Build repo image" },
      { key: "g", action: "Create config scaffold" },
      { key: "y", action: "Copy container config path" },
      { key: "v", action: "Inspect container" },
    ],
  },
  {
    label: "General",
    shortcuts: [
      { key: "r", action: "Refresh" },
      { key: "p", action: "Prune orphans" },
      { key: "f", action: "Fetch repo" },
      { key: "c", action: "Copy path" },
      { key: "b", action: "Copy branch name" },
      { key: "?", action: "Show help" },
      { key: "q / Ctrl+C", action: "Quit" },
    ],
  },
]

export function HelpDialog({
  onClose,
  title = "Keyboard Shortcuts",
  message = "",
}: HelpDialogProps) {
  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "enter" || key.name === "return") {
      onClose()
    }
  })

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
        width={spacing.dialogWidth + 6}
        flexDirection="column"
        paddingX={spacing.dialogPaddingX}
        paddingY={spacing.dialogPaddingY}
      >
        <text>
          <span fg={colors.accent}>
            <strong>{title}</strong>
          </span>
        </text>
        {message ? (
          <box marginTop={1}>
            <text>
              <span fg={colors.textPrimary}>{message}</span>
            </text>
          </box>
        ) : null}
        <box marginTop={1} flexDirection="column">
          {SHORTCUT_SECTIONS.map((section) => (
            <box key={section.label} flexDirection="column" marginBottom={1}>
              <text>
                <span fg={colors.textMuted}>
                  <strong>{section.label}</strong>
                </span>
              </text>
              {section.shortcuts.map((shortcut) => (
                <box key={shortcut.key} flexDirection="row">
                  <box width={24}>
                    <text>
                      <span fg={colors.accent}>{`  ${shortcut.key}`}</span>
                    </text>
                  </box>
                  <text>
                    <span fg={colors.textPrimary}>{shortcut.action}</span>
                  </text>
                </box>
              ))}
            </box>
          ))}
        </box>
        <box flexDirection="row" justifyContent="flex-end">
          <text>
            <span fg={colors.accent} bg={colors.bgHighlight}>
              {" Esc / Enter "}
            </span>
            <span fg={colors.textSecondary}>{" Close"}</span>
          </text>
        </box>
      </box>
    </box>
  )
}
