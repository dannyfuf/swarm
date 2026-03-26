/**
 * Command to build or rebuild the repo container image set.
 */

import type { ContainerBuildService } from "../services/ContainerBuildService.js"
import type { ContainerConfigService } from "../services/ContainerConfigService.js"
import type { Repo } from "../types/repo.js"
import type { Worktree } from "../types/worktree.js"
import type { Command, CommandResult } from "./Command.js"

export class BuildContainerImageCommand implements Command {
  constructor(
    private readonly containerConfigService: ContainerConfigService,
    private readonly containerBuildService: ContainerBuildService,
    private readonly repo: Repo,
    private readonly worktree?: Worktree,
  ) {}

  async execute(): Promise<CommandResult> {
    try {
      const plan = await this.containerBuildService.buildForRepo(
        this.repo.path,
        this.worktree?.path ?? this.repo.path,
        this.worktree?.container,
        true,
      )

      return {
        success: true,
        message: `Built container images for ${this.repo.name}`,
        data: plan,
      }
    } catch (error) {
      if (isMissingContainerConfigError(error)) {
        const scaffold = await this.containerConfigService.ensureConfigScaffold(this.repo.path)
        return {
          success: false,
          message: scaffold.alreadyExisted
            ? `Container config is required. Edit ${scaffold.path} and try again.`
            : `Created container config scaffold at ${scaffold.path}. Edit it and press i again.`,
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
  return error instanceof Error && error.message.includes("Missing container config for repo")
}
