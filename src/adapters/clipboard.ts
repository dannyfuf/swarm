import { SwarmError } from "../core/errors.ts";
import type { Clipboard, Shell } from "../core/ports.ts";

function clipboardError(command: string, stderr: string, cause?: unknown): SwarmError {
  const detail =
    stderr.trim() || (cause instanceof Error ? cause.message : String(cause ?? "unknown error"));
  return new SwarmError("fs", `${command} failed: ${detail}`, { cause });
}

export function createClipboard(
  shell: Shell,
  platform: NodeJS.Platform = process.platform,
): Clipboard {
  return {
    async copy(text): Promise<void> {
      let command = "pbcopy";
      let args: string[] = [];
      try {
        if (platform !== "darwin") {
          const wayland = await shell.run("which", ["wl-copy"]);
          if (wayland.code === 0) command = "wl-copy";
          else {
            command = "xclip";
            args = ["-selection", "clipboard"];
          }
        }
        const result = await shell.run(command, args, { input: text });
        if (result.code !== 0) throw clipboardError(command, result.stderr);
      } catch (error) {
        if (error instanceof SwarmError && error.code === "fs") throw error;
        throw clipboardError(command, "", error);
      }
    },
  };
}
