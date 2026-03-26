/**
 * Command to refresh the worktree list for a repo.
 *
 * Re-lists worktrees from git + state and recomputes statuses.
 * Returns the updated worktree list.
 */

import type { StatusService } from "../services/StatusService.js"
import type { WorktreeService } from "../services/WorktreeService.js"
import type { Repo } from "../types/repo.js"
import type { Command, CommandResult } from "./Command.js"

export class RefreshCommand implements Command {
  constructor(
    private readonly worktreeService: WorktreeService,
    private readonly statusService: StatusService,
    private readonly repo: Repo,
  ) {}

  async execute(): Promise<CommandResult> {
    try {
      // Clear status cache for fresh computation
      this.statusService.clearCache()

      // Re-list worktrees
      const worktrees = await this.worktreeService.list(this.repo)

      // Compute statuses in parallel
      const items = worktrees.map((wt) => ({
        worktree: wt,
        options: {
          repoPath: this.repo.path,
          defaultBranch: this.repo.defaultBranch,
        },
      }))
      const statuses = await this.statusService.computeAll(items)

      return {
        success: true,
        message: `Refreshed ${worktrees.length} worktree(s)`,
        data: { worktrees, statuses },
      }
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : "Unknown error refreshing",
      }
    }
  }
}
