import { join } from "node:path";
import { SwarmError } from "../core/errors.ts";
import type {
  FilesPort,
  Logger,
  Shell,
  ShellResult,
  UpdateEvent,
  UpdaterPort,
} from "../core/ports.ts";

interface UpdaterDependencies {
  shell: Shell;
  files: FilesPort;
  logger: Logger;
}

function outputTail(result: ShellResult): string {
  const output = (result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`)
    .split(/\r?\n/u)
    .slice(-8)
    .join(" | ");
  return output.slice(-800);
}

function commandLabel(cmd: string, args: string[]): string {
  return [cmd, ...args].join(" ");
}

export function createUpdater({ shell, files, logger }: UpdaterDependencies): UpdaterPort {
  const log = logger.child("updater");

  const run = async (
    installRoot: string,
    step: string,
    cmd: string,
    args: string[],
    onEvent?: (event: UpdateEvent) => void,
  ): Promise<ShellResult> => {
    let result: ShellResult;
    try {
      result = await shell.run(cmd, args, {
        cwd: installRoot,
        onStderrLine: (line) => onEvent?.({ type: "log", line }),
      });
    } catch (error) {
      log.error("Update command could not start", {
        cwd: installRoot,
        command: commandLabel(cmd, args),
        error: error instanceof Error ? error.message : String(error),
      });
      throw new SwarmError(
        "fs",
        `Updating swarm: ${step} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    log.info("Update command completed", {
      cwd: installRoot,
      command: commandLabel(cmd, args),
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    if (result.code !== 0) {
      throw new SwarmError(
        cmd === "git" ? "git" : "unsupported",
        `Updating swarm: ${step} failed: ${outputTail(result)}`,
      );
    }
    return result;
  };

  return {
    async update(installRoot, onEvent) {
      onEvent?.({ type: "step", label: "checking install…" });
      const checkout = await run(
        installRoot,
        "checking install root",
        "git",
        ["rev-parse", "--is-inside-work-tree"],
        onEvent,
      );
      if (checkout.stdout.trim() !== "true") {
        throw new SwarmError("git", "update requires a git checkout");
      }

      const branchResult = await run(
        installRoot,
        "checking current branch",
        "git",
        ["branch", "--show-current"],
        onEvent,
      );
      const branch = branchResult.stdout.trim() || "detached HEAD";
      if (branch !== "main") {
        throw new SwarmError("git", `update requires the main branch (current: ${branch})`);
      }

      onEvent?.({ type: "step", label: "checking working tree…" });
      const status = await run(
        installRoot,
        "checking working tree",
        "git",
        ["status", "--porcelain"],
        onEvent,
      );
      if (status.stdout.trim() !== "") {
        throw new SwarmError("git", "update requires a clean working tree");
      }

      onEvent?.({ type: "step", label: "pulling main…" });
      await run(
        installRoot,
        "pulling main",
        "git",
        ["pull", "--ff-only", "origin", "main"],
        onEvent,
      );

      onEvent?.({ type: "step", label: "installing dependencies…" });
      const installArgs = (await files.exists(join(installRoot, "package-lock.json")))
        ? ["ci"]
        : ["install"];
      await run(installRoot, "installing dependencies", "npm", installArgs, onEvent);

      onEvent?.({ type: "step", label: "building…" });
      await run(installRoot, "building", "npm", ["run", "build"], onEvent);
    },
  };
}
