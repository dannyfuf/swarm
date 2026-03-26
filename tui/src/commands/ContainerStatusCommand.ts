/**
 * Command to query live container runtime status for a worktree.
 */

import type { ContainerRuntimeService } from "../services/ContainerRuntimeService.js"
import type { Repo } from "../types/repo.js"
import type { Worktree } from "../types/worktree.js"
import type { Command, CommandResult } from "./Command.js"

export class ContainerStatusCommand implements Command {
  constructor(
    private readonly containerRuntimeService: ContainerRuntimeService,
    private readonly repo: Repo,
    private readonly worktree: Worktree,
  ) {}

  async execute(): Promise<CommandResult> {
    try {
      const status = await this.containerRuntimeService.getStatus(this.repo, this.worktree)
      return {
        success: true,
        message: `Container status: ${status.state}${status.warning ? " (stale image warning)" : ""}`,
        data: status,
      }
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : "Unknown error fetching container status",
      }
    }
  }
}
