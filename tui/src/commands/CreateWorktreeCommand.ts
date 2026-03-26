/**
 * Command to create a new git worktree.
 *
 * Checks if the branch already exists, then creates a new worktree
 * (with a new branch if needed). Returns the created Worktree object.
 */

import type { GitService } from "../services/GitService.js"
import type { WorktreeService } from "../services/WorktreeService.js"
import type { Repo } from "../types/repo.js"
import type { CreateOptions } from "../types/worktree.js"
import type { Command, CommandResult } from "./Command.js"

export class CreateWorktreeCommand implements Command {
  constructor(
    private readonly worktreeService: WorktreeService,
    private readonly gitService: GitService,
    private readonly repo: Repo,
    private readonly branchName: string,
  ) {}

  async execute(): Promise<CommandResult> {
    try {
      const branchInfo = this.gitService.getBranchInfo(this.repo.path, this.branchName)

      const opts: CreateOptions = {
        branch: this.branchName,
        baseBranch: branchInfo.exists ? "" : this.repo.defaultBranch,
        newBranch: !branchInfo.exists,
      }

      const worktree = await this.worktreeService.create(this.repo, opts)

      return {
        success: true,
        message: `Created worktree: ${worktree.branch}`,
        data: worktree,
      }
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : "Unknown error creating worktree",
      }
    }
  }
}
