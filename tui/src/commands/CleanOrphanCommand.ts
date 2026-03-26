/**
 * Command to clean a single orphaned worktree from state.
 *
 * Removes the orphan entry from the state file without touching git.
 */

import type { WorktreeService } from "../services/WorktreeService.js"
import type { Repo } from "../types/repo.js"
import type { Worktree } from "../types/worktree.js"
import type { Command, CommandResult } from "./Command.js"

export class CleanOrphanCommand implements Command {
  constructor(
    private readonly worktreeService: WorktreeService,
    private readonly repo: Repo,
    private readonly worktree: Worktree,
  ) {}

  async execute(): Promise<CommandResult> {
    try {
      await this.worktreeService.cleanOrphans(this.repo, [
        {
          slug: this.worktree.slug,
          branch: this.worktree.branch,
          path: this.worktree.path,
          reason: "Manual cleanup",
          createdAt: this.worktree.createdAt,
        },
      ])

      return {
        success: true,
        message: `Cleaned orphaned worktree: ${this.worktree.branch}`,
        data: this.worktree,
      }
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : "Unknown error cleaning orphan",
      }
    }
  }
}
