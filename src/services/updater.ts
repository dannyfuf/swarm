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
import { createNodeRuntime, outputTail } from "./nodeRuntime.ts";

interface UpdaterDependencies {
  shell: Shell;
  files: FilesPort;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
}

function commandLabel(cmd: string, args: string[]): string {
  return [cmd, ...args].join(" ");
}

export function createUpdater({
  shell,
  files,
  logger,
  env = process.env,
  execPath = process.execPath,
}: UpdaterDependencies): UpdaterPort {
  const log = logger.child("updater");
  const nodeRuntime = createNodeRuntime({ shell, files, logger, env, execPath });

  const run = async (
    installRoot: string,
    step: string,
    cmd: string,
    args: string[],
    onEvent?: (event: UpdateEvent) => void,
    commandEnv?: Record<string, string>,
  ): Promise<ShellResult> => {
    let result: ShellResult;
    try {
      result = await shell.run(cmd, args, {
        cwd: installRoot,
        ...(commandEnv ? { env: commandEnv } : {}),
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

      // Resolved after the pull because the pull can change the pinned .nvmrc version.
      const { binDir } = await nodeRuntime.resolveNodeBinDir(installRoot, onEvent);
      const npm = join(binDir, "npm");
      const npmEnv = nodeRuntime.commandEnv(binDir);

      onEvent?.({ type: "step", label: "installing dependencies…" });
      const installArgs = (await files.exists(join(installRoot, "package-lock.json")))
        ? ["ci"]
        : ["install"];
      await run(installRoot, "installing dependencies", npm, installArgs, onEvent, npmEnv);

      onEvent?.({ type: "step", label: "building…" });
      await run(installRoot, "building", npm, ["run", "build"], onEvent, npmEnv);

      await nodeRuntime.cacheNodeBin(binDir);
    },
  };
}
