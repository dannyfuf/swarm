/**
 * Command to detect and clean all orphaned worktrees for a repo.
 *
 * Orphans are worktrees that exist in state but not in git.
 * Returns the list of cleaned orphans.
 */

import type { WorktreeService } from "../services/WorktreeService.js"
import type { Repo } from "../types/repo.js"
import type { Command, CommandResult } from "./Command.js"

export class PruneOrphansCommand implements Command {
  constructor(
    private readonly worktreeService: WorktreeService,
    private readonly repo: Repo,
  ) {}

  async execute(): Promise<CommandResult> {
    try {
      const orphans = await this.worktreeService.detectOrphans(this.repo)

      if (orphans.length === 0) {
        return {
          success: true,
          message: "No orphaned worktrees found",
          data: orphans,
        }
      }

      await this.worktreeService.cleanOrphans(this.repo, orphans)

      return {
        success: true,
        message: `Pruned ${orphans.length} orphaned worktree(s)`,
        data: orphans,
      }
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : "Unknown error pruning orphans",
      }
    }
  }
}
