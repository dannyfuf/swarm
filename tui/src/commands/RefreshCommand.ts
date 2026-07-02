/**
 * Command to refresh the worktree list for a repo.
 *
 * Re-lists worktrees from git + state and recomputes statuses.
 * Supports streaming results back to the caller so the UI can paint the
 * worktree list immediately and fill in status badges as they compute.
 * Returns the updated worktree list.
 */

import type { StatusService } from "../services/StatusService.js"
import type { WorktreeService } from "../services/WorktreeService.js"
import type { Repo } from "../types/repo.js"
import type { Status } from "../types/status.js"
import type { Worktree } from "../types/worktree.js"
import type { Command, CommandResult } from "./Command.js"

export interface RefreshOptions {
  /**
   * Drop all cached statuses before recomputing. Explicit user refreshes
   * want this; quiet refreshes after create/delete keep warm entries for
   * untouched worktrees.
   */
  clearCache?: boolean
  /** Called with the worktree list as soon as it's available. */
  onWorktrees?: (worktrees: Worktree[]) => void
  /** Called with each status as it finishes computing. */
  onStatus?: (path: string, status: Status) => void
}

export class RefreshCommand implements Command {
  constructor(
    private readonly worktreeService: WorktreeService,
    private readonly statusService: StatusService,
    private readonly repo: Repo,
    private readonly options: RefreshOptions = {},
  ) {}

  async execute(): Promise<CommandResult> {
    try {
      if (this.options.clearCache !== false) {
        this.statusService.clearCache()
      }

      // Re-list worktrees
      const worktrees = await this.worktreeService.list(this.repo)
      this.options.onWorktrees?.(worktrees)

      // Compute statuses concurrently, streaming each as it lands
      const items = worktrees.map((wt) => ({
        worktree: wt,
        options: {
          repoPath: this.repo.path,
          defaultBranch: this.repo.defaultBranch,
        },
      }))
      const statuses = await this.statusService.computeAll(items, this.options.onStatus)

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
