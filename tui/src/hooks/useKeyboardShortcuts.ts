/**
 * Global keyboard shortcut handler for the Swarm TUI.
 *
 * Implements a priority system:
 * 1. Dialog/Input mode - early return (components handle their own keys)
 * 2. Normal mode - all shortcuts (q, n, o, d, r, p, c, b, ?, Tab)
 *
 * Ported from Go `internal/tui/update.go:handleKeyMsg()`.
 */

import { useKeyboard, useRenderer } from "@opentui/react"
import type { AppAction } from "../state/actions.js"
import type { AppState } from "../state/appReducer.js"

interface KeyboardOptions {
  state: AppState
  dispatch: React.Dispatch<AppAction>
  onOpenWorktree: () => void
  onDeleteWorktree: () => void
  onRefresh: () => void
  onPrune: () => void
  onCopy: () => void
  onCopyBranch: () => void
  onHelp: () => void
}

export function useKeyboardShortcuts(opts: KeyboardOptions) {
  const renderer = useRenderer()

  useKeyboard((key) => {
    // Dialog and input components handle their own keyboard events.
    // Skip global shortcuts to avoid duplicate handling.
    if (opts.state.showDialog || opts.state.inputMode !== "none") {
      return
    }

    // Normal mode
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      renderer.destroy()
      return
    }

    switch (key.name) {
      case "tab":
        if (key.shift) {
          opts.dispatch({ type: "CYCLE_PANEL_BACKWARD" })
        } else {
          opts.dispatch({ type: "CYCLE_PANEL_FORWARD" })
        }
        break
      case "n":
        opts.dispatch({ type: "SET_INPUT_MODE", mode: "create" })
        break
      case "o":
      case "enter":
      case "return":
        opts.onOpenWorktree()
        break
      case "d":
        opts.onDeleteWorktree()
        break
      case "r":
        opts.onRefresh()
        break
      case "p":
        opts.onPrune()
        break
      case "c":
        opts.onCopy()
        break
      case "b":
        opts.onCopyBranch()
        break
      case "?":
        opts.onHelp()
        break
    }
  })
}
