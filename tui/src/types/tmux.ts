/**
 * Tmux types for Swarm TUI.
 *
 * Mirrors the Go `internal/tmux/client.go` and `internal/tmux/layout.go` structs.
 * Represents tmux sessions, windows, panes, and layout configuration.
 */

/** A tmux session with its windows. */
export interface Session {
  name: string
  path: string
  windows: string[]
  attached: boolean
}

/** Information about a single tmux window. */
export interface WindowInfo {
  index: number
  name: string
  active: boolean
}

/** A pane split direction. */
export type PaneDirection = "horizontal" | "vertical"

/** A pane within a tmux window layout. */
export interface Pane {
  /** Shell command to execute in this pane. */
  command: string
  /** Split direction relative to the previous pane. */
  direction: PaneDirection
  /** Size as a percentage of the parent. */
  size: number
}

/** A window in a tmux layout configuration. */
export interface Window {
  name: string
  command: string
  panes: Pane[]
}

/** A complete tmux layout definition. */
export interface Layout {
  windows: Window[]
}
