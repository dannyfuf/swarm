/**
 * Tmux types for Swarm TUI.
 *
 * Represents tmux sessions and window information.
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
