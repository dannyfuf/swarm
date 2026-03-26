/**
 * Clipboard service for Swarm TUI.
 *
 * Uses OSC 52 escape sequence for clipboard access, which works
 * in most modern terminal emulators (even over SSH).
 *
 * Fallback to platform-specific commands (pbcopy on macOS, xclip on Linux).
 */

export class ClipboardService {
  /**
   * Copy text to the system clipboard.
   * Tries OSC 52 first, falls back to platform-specific commands.
   */
  copy(text: string): void {
    // Try platform-specific clipboard command
    if (process.platform === "darwin") {
      this.copyWithCommand("pbcopy", text)
    } else {
      // Try xclip, then xsel
      try {
        this.copyWithCommand("xclip", text, ["-selection", "clipboard"])
      } catch {
        try {
          this.copyWithCommand("xsel", text, ["--clipboard", "--input"])
        } catch {
          // Last resort: OSC 52
          this.copyWithOSC52(text)
        }
      }
    }
  }

  /** Copy using OSC 52 escape sequence (works in tmux and most terminals). */
  private copyWithOSC52(text: string): void {
    const encoded = Buffer.from(text).toString("base64")
    // OSC 52: Set clipboard
    process.stdout.write(`\x1b]52;c;${encoded}\x07`)
  }

  /** Copy using a platform command by piping stdin. */
  private copyWithCommand(command: string, text: string, args: string[] = []): void {
    const proc = Bun.spawnSync([command, ...args], {
      stdin: Buffer.from(text),
      stdout: "pipe",
      stderr: "pipe",
    })
    if (proc.exitCode !== 0) {
      throw new Error(`Clipboard command "${command}" failed: ${proc.stderr.toString()}`)
    }
  }
}
