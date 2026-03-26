/**
 * Command pattern interface for Swarm TUI user actions.
 *
 * Every user action (create, open, delete, refresh, etc.) is encapsulated
 * as a Command object that can be executed asynchronously and returns
 * a structured result.
 */

/** Result of executing a command. */
export interface CommandResult {
  /** Whether the command completed successfully. */
  success: boolean
  /** Human-readable status or error message. */
  message: string
  /** Optional payload (e.g. the created worktree, safety check result). */
  data?: unknown
}

/** A command that encapsulates a single user action. */
export interface Command {
  execute(): Promise<CommandResult>
}
