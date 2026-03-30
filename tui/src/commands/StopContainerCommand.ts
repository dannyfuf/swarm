/**
 * Command to stop a worktree container environment.
 */

import type { ContainerRuntimeService } from "../services/ContainerRuntimeService.js"
import type { Worktree } from "../types/worktree.js"
import type { Command, CommandResult } from "./Command.js"

export class StopContainerCommand implements Command {
  constructor(
    private readonly containerRuntimeService: ContainerRuntimeService,
    readonly _repo: unknown,
    private readonly worktree: Worktree,
  ) {}

  async execute(): Promise<CommandResult> {
    try {
      const status = await this.containerRuntimeService.stop(this.worktree)
      return {
        success: true,
        message: `Stopped container for ${this.worktree.branch}`,
        data: status,
      }
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : "Unknown error stopping container",
      }
    }
  }
}
