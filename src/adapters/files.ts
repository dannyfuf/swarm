import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { SwarmError } from "../core/errors.ts";
import type { FilesPort, Logger, Shell } from "../core/ports.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fsError(action: string, error: unknown): SwarmError {
  return error instanceof SwarmError && error.code === "fs"
    ? error
    : new SwarmError("fs", `${action}: ${errorMessage(error)}`, { cause: error });
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function cloneArgs(platform: NodeJS.Platform, src: string, dest: string): string[] {
  return platform === "darwin"
    ? ["-Rc", src, dest]
    : platform === "linux"
      ? ["-R", "--reflink=auto", src, dest]
      : ["-R", src, dest];
}

function detachedCloneScript(platform: NodeJS.Platform): string {
  const copy =
    platform === "darwin" ? "cp -Rc" : platform === "linux" ? "cp -R --reflink=auto" : "cp -R";
  return `source_path=$1
staging_path=$2
hot_path=$3
pid_path=$4
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ]; then rm -rf "$staging_path"; fi
  rm -f "$pid_path"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
printf '%s\\n' "$$" > "$pid_path"
${copy} "$source_path" "$staging_path" && mv "$staging_path" "$hot_path"`;
}

export function createFiles(
  shell: Shell,
  logger: Logger,
  platform: NodeJS.Platform = process.platform,
  allowedRemovalRoots: string[] = [],
): FilesPort {
  const log = logger.child("files");

  const fail = (action: string, error: unknown): never => {
    const wrapped = fsError(action, error);
    log.error(wrapped.message);
    throw wrapped;
  };

  const safeRemovalPath = (path: string): string => {
    const absolute = resolve(path);
    const allowed = allowedRemovalRoots.some((root) => {
      const child = relative(resolve(root), absolute);
      return child !== "" && child !== ".." && !child.startsWith(`..${sep}`);
    });
    if (!allowed) {
      throw new SwarmError("validation", `Refusing to recursively remove unsafe path: ${path}`);
    }
    return absolute;
  };

  return {
    async exists(path): Promise<boolean> {
      try {
        await access(path);
        return true;
      } catch (error) {
        if (isNotFound(error)) return false;
        return fail(`Could not access ${path}`, error);
      }
    },

    async ensureDir(path): Promise<void> {
      try {
        await mkdir(path, { recursive: true });
      } catch (error) {
        fail(`Could not create directory ${path}`, error);
      }
    },

    async cloneTree(src, dest): Promise<void> {
      const args = cloneArgs(platform, src, dest);
      const result = await shell
        .run("cp", args)
        .catch((error: unknown) => fail(`Could not clone ${src} to ${dest}`, error));
      if (result.code !== 0) {
        fail(
          `Could not clone ${src} to ${dest}`,
          new Error(result.stderr.trim() || `cp exited ${result.code}`),
        );
      }
      try {
        await access(dest);
      } catch (error) {
        fail(`Clone destination was not created at ${dest}`, error);
      }
    },

    async cloneTreeDetached(src, staging, dest, pidPath, logPath): Promise<number> {
      try {
        return await shell.spawnDetached(
          "sh",
          ["-c", detachedCloneScript(platform), "swarm-hot-copy", src, staging, dest, pidPath],
          { logPath },
        );
      } catch (error) {
        return fail(`Could not start detached clone ${src} to ${dest}`, error);
      }
    },

    async move(src, dest): Promise<void> {
      try {
        await rename(src, dest);
      } catch (error) {
        fail(`Could not move ${src} to ${dest}`, error);
      }
    },

    async removeTree(path): Promise<void> {
      const absolute = safeRemovalPath(path);
      try {
        await rm(absolute, { recursive: true, force: true });
      } catch (error) {
        fail(`Could not remove ${absolute}`, error);
      }
    },

    async removeDetached(path): Promise<void> {
      const absolute = safeRemovalPath(path);
      try {
        await shell.spawnDetached("rm", ["-rf", absolute]);
      } catch (error) {
        fail(`Could not remove ${absolute}`, error);
      }
    },

    async readText(path): Promise<string | null> {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if (isNotFound(error)) return null;
        return fail(`Could not read ${path}`, error);
      }
    },

    async writeTextAtomic(path, text): Promise<void> {
      const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
      try {
        await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
        await rename(temporary, path);
      } catch (error) {
        fail(`Could not atomically write ${path}`, error);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    },

    async listDirs(path): Promise<string[]> {
      try {
        const entries = await readdir(path, { withFileTypes: true });
        return entries
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".hot"))
          .map((entry) => entry.name)
          .sort();
      } catch (error) {
        return fail(`Could not list directories in ${path}`, error);
      }
    },
  };
}
