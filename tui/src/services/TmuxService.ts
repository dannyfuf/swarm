/**
 * Tmux session management service for Swarm TUI.
 *
 * Wraps tmux CLI commands for session lifecycle management,
 * window/pane creation, and layout application.
 *
 * Ports the Go `internal/tmux/client.go` and `internal/tmux/layout.go`.
 */

import type { Session, WindowInfo } from "../types/tmux.js"
import { exec, execSync } from "../utils/shell.js"

export class TmuxService {
  /** Check if a tmux session exists. */
  hasSession(name: string): boolean {
    const result = execSync("tmux", ["has-session", "-t", name])
    return result.success
  }

  /** Create a new detached tmux session. */
  createSession(name: string, workingDir: string): void {
    const result = execSync("tmux", ["new-session", "-d", "-s", name, "-c", workingDir])
    if (!result.success) {
      throw new Error(`Failed to create tmux session: ${result.stderr}`)
    }
  }

  /**
   * Attach to (or switch to) an existing tmux session.
   * Uses `switch-client` if already inside tmux, `attach-session` otherwise.
   */
  attachSession(name: string): void {
    if (this.isInsideTmux()) {
      const result = execSync("tmux", ["switch-client", "-t", name])
      if (!result.success) {
        throw new Error(`Failed to switch tmux client: ${result.stderr}`)
      }
    } else {
      const result = execSync("tmux", ["attach-session", "-t", name])
      if (!result.success) {
        throw new Error(`Failed to attach tmux session: ${result.stderr}`)
      }
    }
  }

  /** Kill a tmux session. */
  killSession(name: string): void {
    const result = execSync("tmux", ["kill-session", "-t", name])
    if (!result.success) {
      throw new Error(`Failed to kill tmux session: ${result.stderr}`)
    }
  }

  /** List all tmux session names. */
  listSessions(): string[] {
    const result = execSync("tmux", ["list-sessions", "-F", "#{session_name}"])
    if (!result.success) return []
    return result.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
  }

  /** List sessions with detailed information (windows, attached state). */
  listSessionsDetailed(): Session[] {
    const result = execSync("tmux", [
      "list-sessions",
      "-F",
      "#{session_name}|#{session_path}|#{session_attached}",
    ])
    if (!result.success) return []

    const sessions: Session[] = []

    for (const line of result.stdout.split("\n")) {
      if (!line.trim()) continue

      const parts = line.split("|")
      if (parts.length < 3) continue

      const name = parts[0]
      const path = parts[1]
      const attached = parts[2] === "1"

      // Get windows for this session
      const windowResult = execSync("tmux", ["list-windows", "-t", name, "-F", "#{window_name}"])
      const windows = windowResult.success
        ? windowResult.stdout
            .split("\n")
            .map((w) => w.trim())
            .filter(Boolean)
        : []

      sessions.push({ name, path, windows, attached })
    }

    return sessions
  }

  /** List windows for a specific session. */
  listWindows(sessionName: string): WindowInfo[] {
    const result = execSync("tmux", [
      "list-windows",
      "-t",
      sessionName,
      "-F",
      "#{window_index}|#{window_name}|#{window_active}",
    ])
    if (!result.success) return []

    const windows: WindowInfo[] = []
    for (const line of result.stdout.split("\n")) {
      if (!line.trim()) continue
      const parts = line.split("|")
      if (parts.length < 3) continue
      windows.push({
        index: Number.parseInt(parts[0], 10),
        name: parts[1],
        active: parts[2] === "1",
      })
    }
    return windows
  }

  /** Create or attach to a session. */
  createOrAttach(name: string, workingDir: string): void {
    if (this.hasSession(name)) {
      this.attachSession(name)
    } else {
      this.createSession(name, workingDir)
      this.attachSession(name)
    }
  }

  /** Check if we're running inside an existing tmux session. */
  private isInsideTmux(): boolean {
    return !!process.env.TMUX
  }

  // --- Async methods for non-blocking operations ---

  /** Check if a tmux session exists (async). */
  async hasSessionAsync(name: string): Promise<boolean> {
    const result = await exec("tmux", ["has-session", "-t", name])
    return result.success
  }

  /** Kill a tmux session (async). */
  async killSessionAsync(name: string): Promise<void> {
    await exec("tmux", ["kill-session", "-t", name])
  }
}
