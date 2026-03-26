/**
 * Command to start a worktree container environment.
 */

import type { ContainerConfigService } from "../services/ContainerConfigService.js"
import type { ContainerRuntimeService } from "../services/ContainerRuntimeService.js"
import type { WorktreeService } from "../services/WorktreeService.js"
import type { Repo } from "../types/repo.js"
import type { Worktree } from "../types/worktree.js"
import type { Command, CommandResult } from "./Command.js"

export class StartContainerCommand implements Command {
  constructor(
    private readonly containerConfigService: ContainerConfigService,
    private readonly containerRuntimeService: ContainerRuntimeService,
    private readonly worktreeService: WorktreeService,
    private readonly repo: Repo,
    private readonly worktree: Worktree,
  ) {}

  async execute(): Promise<CommandResult> {
    try {
      const result = await this.containerRuntimeService.start(this.repo, this.worktree)
      await this.worktreeService.updateContainerMetadata(this.repo, this.worktree, result.metadata)

      const warningSuffix = result.warning ? ` Warning: ${result.warning}` : ""

      return {
        success: true,
        message: `Started container for ${this.worktree.branch}${result.status.primaryUrl ? ` at ${result.status.primaryUrl}` : ""}.${warningSuffix}`,
        data: result,
      }
    } catch (error) {
      if (isMissingContainerConfigError(error)) {
        const scaffold = await this.containerConfigService.ensureConfigScaffold(this.repo.path)
        return {
          success: false,
          message: scaffold.alreadyExisted
            ? `Container config is required. Edit ${scaffold.path} and try again.`
            : `Created container config scaffold at ${scaffold.path}. Edit it and press s again.`,
          data: scaffold,
        }
      }

      return {
        success: false,
        message: error instanceof Error ? error.message : "Unknown error starting container",
      }
    }
  }
}

function isMissingContainerConfigError(error: unknown): error is Error {
  return error instanceof Error && error.message.includes("Missing container config for repo")
}
