/**
 * Command to check removal safety for a worktree.
 *
 * Runs safety checks (uncommitted changes, unpushed commits) and returns
 * the CheckResult so the UI can display blockers/warnings before deletion.
 */

import type { SafetyService } from "../services/SafetyService.js"
import type { Worktree } from "../types/worktree.js"
import type { Command, CommandResult } from "./Command.js"

export class CheckRemovalSafetyCommand implements Command {
  constructor(
    private readonly safetyService: SafetyService,
    private readonly worktree: Worktree,
  ) {}

  async execute(): Promise<CommandResult> {
    try {
      const result = this.safetyService.checkRemoval(this.worktree)

      if (result.blockers.length > 0) {
        const blockerMessages = result.blockers.map((b) => b.message).join(", ")
        return {
          success: false,
          message: `Cannot remove: ${blockerMessages}`,
          data: result,
        }
      }

      if (result.warnings.length > 0) {
        const warningMessages = result.warnings.map((w) => w.message).join(", ")
        return {
          success: true,
          message: `Warnings: ${warningMessages}`,
          data: result,
        }
      }

      return {
        success: true,
        message: "Safe to remove",
        data: result,
      }
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : "Unknown error checking safety",
      }
    }
  }
}
