import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { getSystemErrorMessage, getSystemErrorName } from "node:util";
import { SwarmError } from "../core/errors.ts";
import type { FilesPort, Logger, Shell } from "../core/ports.ts";

type CloneDirectory = (
  src: string,
  dest: string,
  onDestinationCreated: () => void,
) => Promise<void>;

export interface FilesOptions {
  cloneDirectory?: CloneDirectory;
}

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

async function cloneDirectoryWithNodeFfi(
  src: string,
  dest: string,
  onDestinationCreated: () => void,
): Promise<void> {
  const ffi = await import("node:ffi");
  const handle = ffi.dlopen("/usr/lib/libSystem.B.dylib", {
    clonefile: {
      arguments: ["pointer", "pointer", "uint32"],
      return: "int32",
    },
    __error: { return: "pointer" },
  });
  try {
    if (handle.functions.clonefile(src, dest, 0) === 0) return;
    const errno = ffi.getInt32(handle.functions.__error());
    const systemErrorName = getSystemErrorName(-errno);
    const error = new Error(
      `clonefile failed: ${systemErrorName} (${getSystemErrorMessage(-errno)})`,
    );
    (error as NodeJS.ErrnoException).code = systemErrorName;
    if (systemErrorName !== "EEXIST" && systemErrorName !== "ENOTEMPTY") {
      try {
        await access(dest);
        onDestinationCreated();
      } catch {
        // clonefile failed before creating the destination.
      }
    }
    throw error;
  } finally {
    handle.lib.close();
  }
}

export function createFiles(
  shell: Shell,
  logger: Logger,
  platform: NodeJS.Platform = process.platform,
  allowedRemovalRoots: string[] = [],
  options: FilesOptions = {},
): FilesPort {
  const log = logger.child("files");
  const cloneDirectory = options.cloneDirectory ?? cloneDirectoryWithNodeFfi;
  let loggedCloneFallback = false;

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
      if (platform === "darwin") {
        try {
          await mkdir(dirname(dest), { recursive: true });
        } catch (error) {
          fail(`Could not prepare clone destination ${dest}`, error);
        }

        let destinationExists = false;
        try {
          await access(dest);
          destinationExists = true;
        } catch (error) {
          if (!isNotFound(error)) fail(`Could not access clone destination ${dest}`, error);
        }
        if (destinationExists) {
          fail(`Could not clone ${src} to ${dest}`, new Error("clone destination already exists"));
        }

        let cloneMadeProgress = false;
        try {
          await cloneDirectory(src, dest, () => {
            cloneMadeProgress = true;
          });
          return;
        } catch (error) {
          let existsAfterFailure = false;
          try {
            await access(dest);
            existsAfterFailure = true;
          } catch (accessError) {
            if (!isNotFound(accessError)) {
              fail(`Could not access failed clone destination ${dest}`, accessError);
            }
          }
          if (existsAfterFailure && !cloneMadeProgress) {
            fail(`Could not clone ${src} to ${dest}`, error);
          }
          if (cloneMadeProgress) {
            try {
              await rm(dest, { recursive: true, force: true });
            } catch (cleanupError) {
              fail(`Could not clean failed clone destination ${dest}`, cleanupError);
            }
          }
          if (!loggedCloneFallback) {
            loggedCloneFallback = true;
            log.warn("Directory clonefile unavailable; falling back to cp -Rc", {
              reason: errorMessage(error),
            });
          }
        }
      }

      const args =
        platform === "darwin"
          ? ["-Rc", src, dest]
          : platform === "linux"
            ? ["-R", "--reflink=auto", src, dest]
            : ["-R", src, dest];
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

    async listDirs(path, opts): Promise<string[]> {
      try {
        const entries = await readdir(path, { withFileTypes: true });
        return entries
          .filter(
            (entry) =>
              entry.isDirectory() && (opts?.includeReserved || !entry.name.startsWith(".hot")),
          )
          .map((entry) => entry.name)
          .sort();
      } catch (error) {
        return fail(`Could not list directories in ${path}`, error);
      }
    },
  };
}
