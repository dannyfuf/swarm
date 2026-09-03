import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { SwarmError } from "../core/errors.ts";
import type { FilesPort, Logger, Shell, ShellResult, UpdateEvent } from "../core/ports.ts";

export interface NodeRuntimeDependencies {
  shell: Shell;
  files: FilesPort;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
}

export interface ResolvedNodeBin {
  /** Absolute path to the `bin` directory holding `node` and `npm`. */
  binDir: string;
  /** Version requested by `.nvmrc`, or `null` when there is no usable `.nvmrc`. */
  version: string | null;
  /** Human readable explanation of why this bin dir was chosen. */
  reason: string;
}

export interface NodeRuntimePort {
  /** Resolves the node bin dir pinned by `<installRoot>/.nvmrc`, installing it with nvm if needed. */
  resolveNodeBinDir(
    installRoot: string,
    onEvent?: (event: UpdateEvent) => void,
  ): Promise<ResolvedNodeBin>;
  /** Env overrides that put `binDir` first on PATH. */
  commandEnv(binDir: string): Record<string, string>;
  /** Persists `<binDir>/node` to `$SWARM_HOME/cache/node-bin` unless it is already the running node. */
  cacheNodeBin(binDir: string): Promise<void>;
}

const VERSION_PATTERN = /^\d+(?:\.\d+){0,2}$/u;

export function outputTail(result: ShellResult): string {
  const output = (result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`)
    .split(/\r?\n/u)
    .slice(-8)
    .join(" | ");
  return output.slice(-800);
}

function parseVersion(raw: string): string | null {
  const trimmed = raw.trim().replace(/^v/u, "");
  return VERSION_PATTERN.test(trimmed) ? trimmed : null;
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".");
  const right = b.split(".");
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = Number(left[index] ?? 0) - Number(right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function createNodeRuntime({
  shell,
  files,
  logger,
  env = process.env,
  execPath = process.execPath,
}: NodeRuntimeDependencies): NodeRuntimePort {
  const log = logger.child("node-runtime");

  const home = (): string => env.HOME || homedir();
  const nvmDir = (): string => env.NVM_DIR || join(home(), ".nvm");

  /**
   * Highest installed directory under `versionsDir` whose name is `<namePrefix><version>` or starts
   * with `<namePrefix><version>.`, so a partial `.nvmrc` such as `26` or `26.8` still resolves.
   */
  const bestInstalled = async (
    versionsDir: string,
    namePrefix: string,
    version: string,
  ): Promise<string | null> => {
    if (!(await files.exists(versionsDir))) return null;
    let names: string[];
    try {
      names = await files.listDirs(versionsDir);
    } catch (error) {
      log.warn("Could not list node installs", {
        dir: versionsDir,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    const wanted = `${namePrefix}${version}`;
    const matches = names.filter((name) => name === wanted || name.startsWith(`${wanted}.`));
    let best: string | null = null;
    for (const name of matches) {
      const candidate = name.slice(namePrefix.length);
      if (!VERSION_PATTERN.test(candidate)) continue;
      if (best === null || compareVersions(candidate, best.slice(namePrefix.length)) > 0) {
        best = name;
      }
    }
    return best;
  };

  const findInstalled = async (version: string): Promise<ResolvedNodeBin | null> => {
    const nvmVersions = join(nvmDir(), "versions", "node");
    const nvmMatch = await bestInstalled(nvmVersions, "v", version);
    if (nvmMatch) {
      return {
        binDir: join(nvmVersions, nvmMatch, "bin"),
        version,
        reason: `.nvmrc ${version} matched nvm install ${nvmMatch}`,
      };
    }
    const nodenvVersions = join(home(), ".nodenv", "versions");
    const nodenvMatch = await bestInstalled(nodenvVersions, "", version);
    if (nodenvMatch) {
      return {
        binDir: join(nodenvVersions, nodenvMatch, "bin"),
        version,
        reason: `.nvmrc ${version} matched nodenv install ${nodenvMatch}`,
      };
    }
    return null;
  };

  const installWithNvm = async (
    installRoot: string,
    version: string,
    onEvent?: (event: UpdateEvent) => void,
  ): Promise<void> => {
    const nvmScript = join(nvmDir(), "nvm.sh");
    if (!(await files.exists(nvmScript))) {
      throw new SwarmError(
        "unsupported",
        `Updating swarm: node ${version} (from .nvmrc) is not installed and nvm was not found at ${nvmScript}`,
      );
    }

    onEvent?.({ type: "step", label: `installing node ${version}…` });
    let result: ShellResult;
    try {
      // cwd is the install root so `nvm install` reads the repo .nvmrc.
      result = await shell.run("bash", ["-c", '. "$NVM_DIR/nvm.sh" && nvm install'], {
        cwd: installRoot,
        env: { NVM_DIR: nvmDir() },
        onStderrLine: (line) => onEvent?.({ type: "log", line }),
      });
    } catch (error) {
      throw new SwarmError(
        "fs",
        `Updating swarm: installing node ${version} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    if (result.code !== 0) {
      throw new SwarmError(
        "unsupported",
        `Updating swarm: installing node ${version} failed: ${outputTail(result)}`,
      );
    }
  };

  return {
    async resolveNodeBinDir(installRoot, onEvent): Promise<ResolvedNodeBin> {
      const nvmrcPath = join(installRoot, ".nvmrc");
      let raw: string | null = null;
      try {
        raw = await files.readText(nvmrcPath);
      } catch (error) {
        log.warn("Could not read .nvmrc", {
          path: nvmrcPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const version = raw === null ? null : parseVersion(raw);
      if (version === null) {
        const fallback: ResolvedNodeBin = {
          binDir: dirname(execPath),
          version: null,
          reason:
            raw === null
              ? "no .nvmrc, using the node running swarm"
              : `unusable .nvmrc (${raw.trim()}), using the node running swarm`,
        };
        log.info("Resolved node bin dir", fallback);
        return fallback;
      }

      let resolved = await findInstalled(version);
      if (!resolved) {
        await installWithNvm(installRoot, version, onEvent);
        resolved = await findInstalled(version);
        if (!resolved) {
          throw new SwarmError(
            "unsupported",
            `Updating swarm: node ${version} (from .nvmrc) is still missing after nvm install`,
          );
        }
      }
      log.info("Resolved node bin dir", resolved);
      return resolved;
    },

    commandEnv(binDir): Record<string, string> {
      const current = env.PATH;
      return { PATH: current ? `${binDir}${delimiter}${current}` : binDir };
    },

    async cacheNodeBin(binDir): Promise<void> {
      const nodeBin = join(binDir, "node");
      if (nodeBin === execPath) return;
      const swarmHome = env.SWARM_HOME ?? join(home(), ".swarm");
      const cachePath = join(swarmHome, "cache", "node-bin");
      try {
        await files.ensureDir(dirname(cachePath));
        await files.writeTextAtomic(cachePath, `${nodeBin}\n`);
        log.info("Cached node binary for the next launch", { cachePath, nodeBin });
      } catch (error) {
        log.warn("Could not cache node binary", {
          cachePath,
          nodeBin,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
