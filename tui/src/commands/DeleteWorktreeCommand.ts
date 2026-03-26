/**
 * Command to delete a worktree.
 *
 * Removes the worktree from git and state. Optionally kills the associated
 * tmux session and deletes the branch if it's been merged.
 */

import type { ContainerRuntimeService } from "../services/ContainerRuntimeService.js"
import type { GitService } from "../services/GitService.js"
import type { TmuxService } from "../services/TmuxService.js"
import type { WorktreeService } from "../services/WorktreeService.js"
import type { Repo } from "../types/repo.js"
import type { Worktree } from "../types/worktree.js"
import type { Command, CommandResult } from "./Command.js"

export class DeleteWorktreeCommand implements Command {
  constructor(
    private readonly worktreeService: WorktreeService,
    private readonly containerRuntimeService: ContainerRuntimeService,
    private readonly gitService: GitService,
    private readonly tmuxService: TmuxService,
    private readonly repo: Repo,
    private readonly worktree: Worktree,
    private readonly force: boolean = false,
  ) {}

  async execute(): Promise<CommandResult> {
    try {
      if (this.worktree.container) {
        await this.containerRuntimeService.removeEnvironment(this.worktree)
      }

      // Kill the tmux session if it exists
      if (await this.tmuxService.hasSessionAsync(this.worktree.tmuxSession)) {
        try {
          await this.tmuxService.killSessionAsync(this.worktree.tmuxSession)
        } catch {
          // Ignore tmux kill errors
        }
      }

      // Remove the worktree (git + state)
      await this.worktreeService.remove(this.repo, this.worktree, this.force)

      // Try to delete the branch if it's merged
      try {
        if (await this.gitService.isMergedAsync(this.repo.path, this.worktree.branch)) {
          await this.gitService.deleteBranchAsync(this.repo.path, this.worktree.branch)
        }
      } catch {
        // Branch deletion is best-effort
      }

      return {
        success: true,
        message: `Deleted worktree: ${this.worktree.branch}`,
        data: this.worktree,
      }
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : "Unknown error deleting worktree",
      }
    }
  }
}
