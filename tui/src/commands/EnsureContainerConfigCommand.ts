/**
 * Command to create a missing repo container config scaffold.
 */

import type { ContainerConfigService } from "../services/ContainerConfigService.js"
import type { Repo } from "../types/repo.js"
import type { Command, CommandResult } from "./Command.js"

export class EnsureContainerConfigCommand implements Command {
  constructor(
    private readonly containerConfigService: ContainerConfigService,
    private readonly repo: Repo,
  ) {}

  async execute(): Promise<CommandResult> {
    try {
      const scaffold = await this.containerConfigService.ensureConfigScaffold(this.repo.path)
      return {
        success: true,
        message: scaffold.alreadyExisted
          ? `Repo dockerization already exists at ${scaffold.composeFilePath}`
          : `Created repo dockerization scaffold at ${scaffold.composeFilePath}`,
        data: scaffold,
      }
    } catch (error) {
      return {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unknown error creating container config scaffold",
      }
    }
  }
}
