/**
 * Command to copy text to the system clipboard.
 *
 * Used for copying repo paths, worktree paths, and branch names.
 */

import type { ClipboardService } from "../services/ClipboardService.js"
import type { Command, CommandResult } from "./Command.js"

export class CopyToClipboardCommand implements Command {
  constructor(
    private readonly clipboardService: ClipboardService,
    private readonly text: string,
    private readonly label: string,
  ) {}

  async execute(): Promise<CommandResult> {
    try {
      this.clipboardService.copy(this.text)

      return {
        success: true,
        message: `Copied ${this.label} to clipboard`,
      }
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : "Unknown error copying to clipboard",
      }
    }
  }
}
