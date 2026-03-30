/**
 * Command to create a new worktree and immediately start its environment.
 */

import type { ContainerConfigService } from "../services/ContainerConfigService.js"
import type { ContainerRuntimeService } from "../services/ContainerRuntimeService.js"
import type { GitService } from "../services/GitService.js"
import type { WorktreeService } from "../services/WorktreeService.js"
import type { Repo } from "../types/repo.js"
import type { CreateOptions } from "../types/worktree.js"
import type { Command, CommandResult } from "./Command.js"

export class CreateAndStartWorktreeCommand implements Command {
  constructor(
    private readonly containerConfigService: ContainerConfigService,
    private readonly worktreeService: WorktreeService,
    private readonly gitService: GitService,
    private readonly containerRuntimeService: ContainerRuntimeService,
    private readonly repo: Repo,
    private readonly branchName: string,
  ) {}

  async execute(): Promise<CommandResult> {
    try {
      const branchInfo = await this.gitService.getBranchInfoAsync(this.repo.path, this.branchName)

      const opts: CreateOptions = {
        branch: this.branchName,
        baseBranch: branchInfo.exists ? "" : this.repo.defaultBranch,
        newBranch: !branchInfo.exists,
      }

      const worktree = await this.worktreeService.create(this.repo, opts)
      const startResult = await this.containerRuntimeService.start(this.repo, worktree)
      await this.worktreeService.updateContainerMetadata(this.repo, worktree, startResult.metadata)

      return {
        success: true,
        message: `Created worktree ${worktree.branch} and started container${startResult.status.primaryUrl ? ` at ${startResult.status.primaryUrl}` : ""}`,
        data: { worktree, startResult },
      }
    } catch (error) {
      if (isMissingContainerConfigError(error)) {
        const scaffold = await this.containerConfigService.ensureConfigScaffold(this.repo.path)
        return {
          success: false,
          message: scaffold.alreadyExisted
            ? `Repo dockerization is required. Add or update ${scaffold.composeFilePath} and try again.`
            : `Created repo dockerization scaffold at ${scaffold.composeFilePath}. Edit it and press N again.`,
          data: scaffold,
        }
      }

      return {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unknown error creating worktree and starting container",
      }
    }
  }
}

function isMissingContainerConfigError(error: unknown): error is Error {
  return error instanceof Error && error.message.includes("Missing repo dockerization directory")
}
