/**
 * Command to build or rebuild the repo container image set.
 */

import type { ContainerBuildService } from "../services/ContainerBuildService.js"
import type { ContainerConfigService } from "../services/ContainerConfigService.js"
import type { ContainerRuntimeService } from "../services/ContainerRuntimeService.js"
import type { Repo } from "../types/repo.js"
import type { Worktree } from "../types/worktree.js"
import type { Command, CommandResult } from "./Command.js"

export class BuildContainerImageCommand implements Command {
  constructor(
    private readonly containerConfigService: ContainerConfigService,
    _containerBuildService: ContainerBuildService,
    private readonly containerRuntimeService: ContainerRuntimeService,
    private readonly repo: Repo,
    private readonly worktree?: Worktree,
  ) {
    void _containerBuildService
  }

  async execute(): Promise<CommandResult> {
    try {
      if (!this.worktree) {
        throw new Error("Container builds must be run from a managed worktree.")
      }

      const plan = await this.containerRuntimeService.build(this.repo, this.worktree)

      return {
        success: true,
        message: `Built compose services for ${this.repo.name}`,
        data: plan,
      }
    } catch (error) {
      if (isMissingContainerConfigError(error)) {
        const scaffold = await this.containerConfigService.ensureConfigScaffold(this.repo.path)
        return {
          success: false,
          message: scaffold.alreadyExisted
            ? `Repo dockerization is required. Add or update ${scaffold.composeFilePath} and try again.`
            : `Created repo dockerization scaffold at ${scaffold.composeFilePath}. Edit it and press i again.`,
          data: scaffold,
        }
      }

      return {
        success: false,
        message: error instanceof Error ? error.message : "Unknown error building container image",
      }
    }
  }
}

function isMissingContainerConfigError(error: unknown): error is Error {
  return error instanceof Error && error.message.includes("Missing repo dockerization directory")
}
