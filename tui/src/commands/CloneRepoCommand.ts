/**
 * Command to clone a remote GitHub repository.
 *
 * Clones the repository into the AI working directory.
 * Returns the cloned path on success.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import type { GitHubService } from "../services/GitHubService.js"
import type { RemoteRepo } from "../types/github.js"
import type { Command, CommandResult } from "./Command.js"

export class CloneRepoCommand implements Command {
  constructor(
    private readonly githubService: GitHubService,
    private readonly aiWorkingDir: string,
    private readonly repo: RemoteRepo,
  ) {}

  async execute(): Promise<CommandResult> {
    try {
      const targetDir = join(this.aiWorkingDir, this.repo.name)

      if (existsSync(targetDir)) {
        return {
          success: false,
          message: `Repository "${this.repo.name}" already exists at ${targetDir}`,
        }
      }

      await this.githubService.cloneRepo(this.repo.cloneUrl, targetDir)

      return {
        success: true,
        message: `Cloned ${this.repo.fullName}`,
        data: { path: targetDir },
      }
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : "Unknown error cloning repository",
      }
    }
  }
}
