/**
 * Command to open a worktree in a tmux session.
 *
 * Creates a tmux session if it doesn't exist, then attaches/switches to it.
 * Updates the lastOpenedAt timestamp.
 */

import type { TmuxService } from "../services/TmuxService.js"
import type { WorktreeService } from "../services/WorktreeService.js"
import type { Repo } from "../types/repo.js"
import type { Worktree } from "../types/worktree.js"
import type { Command, CommandResult } from "./Command.js"

export class OpenWorktreeCommand implements Command {
  constructor(
    private readonly tmuxService: TmuxService,
    private readonly worktreeService: WorktreeService,
    private readonly repo: Repo,
    private readonly worktree: Worktree,
  ) {}

  async execute(): Promise<CommandResult> {
    try {
      const sessionName = this.worktree.tmuxSession

      if (!this.tmuxService.hasSession(sessionName)) {
        this.tmuxService.createSession(sessionName, this.worktree.path)
      }

      // Attach or switch to the session
      this.tmuxService.attachSession(sessionName)

      // Update last opened timestamp
      await this.worktreeService.updateLastOpened(this.repo, this.worktree)

      return {
        success: true,
        message: `Opened worktree: ${this.worktree.branch}`,
        data: this.worktree,
      }
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : "Unknown error opening worktree",
      }
    }
  }
}
