import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { SwarmError } from "../core/errors.ts";
import type { Logger, RunOptions, Shell, ShellResult } from "../core/ports.ts";
import { noStartupTiming, type StartupTiming } from "../core/startup.ts";

export type RunOptionsWithInput = RunOptions;

const TERMINATE_GRACE_MS = 500;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createShell(logger: Logger, startup: StartupTiming = noStartupTiming): Shell {
  const log = logger.child("shell");

  const shell: Shell = {
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

    async spawnDetached(cmd, args, opts): Promise<number> {
      return await new Promise<number>((resolve, reject) => {
        let child: ReturnType<typeof spawn>;
        let logFd: number | undefined;
        try {
          logFd = opts?.logPath ? openSync(opts.logPath, "a", 0o600) : undefined;
          child = spawn(cmd, args, {
            cwd: opts?.cwd,
            detached: true,
            stdio: logFd === undefined ? "ignore" : ["ignore", logFd, logFd],
          });
        } catch (error) {
          if (logFd !== undefined) closeSync(logFd);
          log.error("Failed to spawn detached command", { cmd, error: errorMessage(error) });
          reject(
            new SwarmError("fs", `Failed to spawn ${cmd}: ${errorMessage(error)}`, {
              cause: error,
            }),
          );
          return;
        }
        let settled = false;
        child.once("error", (error) => {
          if (settled) return;
          settled = true;
          if (logFd !== undefined) closeSync(logFd);
          log.error("Failed to spawn detached command", { cmd, error: errorMessage(error) });
          reject(
            new SwarmError("fs", `Failed to spawn ${cmd}: ${errorMessage(error)}`, {
              cause: error,
            }),
          );
        });
        child.once("spawn", () => {
          if (settled) return;
          settled = true;
          if (logFd !== undefined) closeSync(logFd);
          const pid = child.pid;
          if (pid === undefined) {
            reject(new SwarmError("fs", `Failed to obtain pid for ${cmd}`));
            return;
          }
          child.unref();
          resolve(pid);
        });
      });
    },

    async runDetachedLogged(cmd, args, opts): Promise<number> {
      return await new Promise<number>((resolve, reject) => {
        let child: ReturnType<typeof spawn>;
        let logFd: number | undefined;
        try {
          logFd = openSync(opts.logPath, "a", 0o600);
          child = spawn(cmd, args, {
            cwd: opts.cwd,
            detached: true,
            stdio: ["ignore", logFd, logFd],
          });
        } catch (error) {
          if (logFd !== undefined) closeSync(logFd);
          log.error("Failed to spawn detached logged command", {
            cmd,
            error: errorMessage(error),
          });
          reject(
            new SwarmError("fs", `Failed to spawn ${cmd}: ${errorMessage(error)}`, {
              cause: error,
            }),
          );
          return;
        }

        let settled = false;
        child.once("error", (error) => {
          if (settled) return;
          settled = true;
          if (logFd !== undefined) closeSync(logFd);
          reject(
            new SwarmError("fs", `Failed to spawn ${cmd}: ${errorMessage(error)}`, {
              cause: error,
            }),
          );
        });
        child.once("spawn", () => {
          if (logFd !== undefined) {
            closeSync(logFd);
            logFd = undefined;
          }
          child.unref();
        });
        child.once("close", (code) => {
          if (settled) return;
          settled = true;
          resolve(code ?? 1);
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

  return {
    ...shell,
    run(cmd, args, opts) {
      return startup.measure(`shell.${cmd}`, () => shell.run(cmd, args, opts));
    },
  };
}
