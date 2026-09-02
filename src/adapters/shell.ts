import { spawn } from "node:child_process";
import { SwarmError } from "../core/errors.ts";
import type { Logger, RunOptions, Shell, ShellResult } from "../core/ports.ts";

export type RunOptionsWithInput = RunOptions;

const TERMINATE_GRACE_MS = 500;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createShell(logger: Logger): Shell {
  const log = logger.child("shell");

  return {
    async run(cmd, args, opts?: RunOptionsWithInput): Promise<ShellResult> {
      if (opts?.signal?.aborted) {
        throw new SwarmError("cancelled", `Command cancelled before start: ${cmd}`);
      }

      return await new Promise<ShellResult>((resolve, reject) => {
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(cmd, args, {
            cwd: opts?.cwd,
            env: { ...process.env, ...opts?.env },
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch (error) {
          log.error("Failed to spawn command", { cmd, error: errorMessage(error) });
          reject(
            new SwarmError("fs", `Failed to spawn ${cmd}: ${errorMessage(error)}`, {
              cause: error,
            }),
          );
          return;
        }

        let stdout = "";
        let stderr = "";
        let stderrLineBuffer = "";
        let settled = false;
        let timedOut = false;
        let aborted = false;
        let timeout: NodeJS.Timeout | undefined;
        let killTimeout: NodeJS.Timeout | undefined;

        const emitStderrLine = (line: string): void => {
          try {
            opts?.onStderrLine?.(line);
          } catch (error) {
            log.error("Stderr line callback failed", { cmd, error: errorMessage(error) });
          }
        };

        const drainStderrLines = (flush: boolean): void => {
          while (stderrLineBuffer.length > 0) {
            const match = /\r\n|\r|\n/.exec(stderrLineBuffer);
            if (!match || match.index === undefined) break;
            const delimiterEnd = match.index + match[0].length;
            if (!flush && match[0] === "\r" && delimiterEnd === stderrLineBuffer.length) break;
            emitStderrLine(stderrLineBuffer.slice(0, match.index));
            stderrLineBuffer = stderrLineBuffer.slice(delimiterEnd);
          }
          if (flush && stderrLineBuffer.length > 0) {
            emitStderrLine(stderrLineBuffer);
            stderrLineBuffer = "";
          }
        };

        const cleanUp = (): void => {
          if (timeout) clearTimeout(timeout);
          if (killTimeout) clearTimeout(killTimeout);
          opts?.signal?.removeEventListener("abort", abort);
        };

        const terminate = (): void => {
          child.kill("SIGTERM");
          killTimeout = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          }, TERMINATE_GRACE_MS);
          killTimeout.unref();
        };

        const abort = (): void => {
          if (settled || aborted) return;
          aborted = true;
          terminate();
        };

        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.on("data", (chunk: string) => {
          stderr += chunk;
          stderrLineBuffer += chunk;
          drainStderrLines(false);
        });
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(opts?.input);

        child.once("error", (error) => {
          if (settled) return;
          settled = true;
          cleanUp();
          if (aborted) {
            reject(new SwarmError("cancelled", `Command cancelled: ${cmd}`, { cause: error }));
            return;
          }
          log.error("Failed to spawn command", { cmd, error: errorMessage(error) });
          reject(
            new SwarmError("fs", `Failed to spawn ${cmd}: ${errorMessage(error)}`, {
              cause: error,
            }),
          );
        });

        child.once("close", (code) => {
          if (settled) return;
          settled = true;
          cleanUp();
          drainStderrLines(true);
          if (aborted) {
            reject(new SwarmError("cancelled", `Command cancelled: ${cmd}`));
            return;
          }
          resolve({ code: code ?? (timedOut ? 124 : 1), stdout, stderr });
        });

        if (opts?.timeoutMs !== undefined) {
          timeout = setTimeout(() => {
            timedOut = true;
            log.warn("Command timed out", { cmd, timeoutMs: opts.timeoutMs });
            terminate();
          }, opts.timeoutMs);
          timeout.unref();
        }
        opts?.signal?.addEventListener("abort", abort, { once: true });
        if (opts?.signal?.aborted) abort();
      });
    },

    async spawnDetached(cmd, args, opts): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(cmd, args, {
            cwd: opts?.cwd,
            detached: true,
            stdio: "ignore",
          });
        } catch (error) {
          log.error("Failed to spawn detached command", { cmd, error: errorMessage(error) });
          reject(
            new SwarmError("fs", `Failed to spawn ${cmd}: ${errorMessage(error)}`, {
              cause: error,
            }),
          );
          return;
        }
        child.once("error", (error) => {
          log.error("Failed to spawn detached command", { cmd, error: errorMessage(error) });
          reject(
            new SwarmError("fs", `Failed to spawn ${cmd}: ${errorMessage(error)}`, {
              cause: error,
            }),
          );
        });
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
    },

    async exec(cmd, args): Promise<never> {
      const code = await new Promise<number>((resolve, reject) => {
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(cmd, args, { stdio: "inherit" });
        } catch (error) {
          reject(
            new SwarmError("fs", `Failed to spawn ${cmd}: ${errorMessage(error)}`, {
              cause: error,
            }),
          );
          return;
        }
        child.once("error", (error) => {
          reject(
            new SwarmError("fs", `Failed to spawn ${cmd}: ${errorMessage(error)}`, {
              cause: error,
            }),
          );
        });
        child.once("close", (exitCode) => resolve(exitCode ?? 1));
      });
      process.exit(code);
    },
  };
}
