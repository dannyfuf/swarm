import { AsyncLocalStorage } from "node:async_hooks";
import { open, unlink } from "node:fs/promises";
import { z } from "zod";
import { SwarmError } from "../core/errors.ts";
import type { FilesPort, Logger, ProcessPort, StatePort } from "../core/ports.ts";
import { defaultState, type State, StateSchema } from "../core/types.ts";

function formatValidationError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
  }
  if (error instanceof SyntaxError) return `Invalid JSON: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function parseState(text: string): State {
  return StateSchema.parse(JSON.parse(text));
}

export interface TransactionalStatePort extends StatePort {
  mutate<T>(mutation: (state: State) => Promise<T> | T): Promise<T>;
}

const wait = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
};

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export interface StateStoreOptions {
  process: Pick<ProcessPort, "isAlive">;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  emptyLockGraceMs?: number;
}

export function createStateStore(
  files: FilesPort,
  path: string,
  logger: Logger,
  options: StateStoreOptions,
): TransactionalStatePort {
  const lockTimeoutMs = options.lockTimeoutMs ?? 3_000;
  const lockRetryMs = options.lockRetryMs ?? 25;
  const emptyLockGraceMs = options.emptyLockGraceMs ?? 1_000;
  let saveChain: Promise<void> = Promise.resolve();
  const transaction = new AsyncLocalStorage<State>();
  const lockPath = `${path}.lock`;

  const loadFromDisk = async (): Promise<State> => {
    const text = await files.readText(path);
    if (text === null) return defaultState();

    try {
      return parseState(text);
    } catch (cause) {
      const brokenPath = `${path}.broken-${Date.now()}`;
      await files.move(path, brokenPath);
      logger.warn("Quarantined invalid state file", { path, brokenPath });
      throw new SwarmError(
        "validation",
        `Invalid state file ${path}: ${formatValidationError(cause)}`,
        { cause },
      );
    }
  };

  const validate = (state: State): State => {
    try {
      return StateSchema.parse(state);
    } catch (cause) {
      throw new SwarmError(
        "validation",
        `Cannot save invalid state: ${formatValidationError(cause)}`,
        { cause },
      );
    }
  };

  const withFileLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const deadline = Date.now() + lockTimeoutMs;
    let handle: Awaited<ReturnType<typeof open>>;
    while (true) {
      try {
        const candidate = await open(lockPath, "wx");
        try {
          await candidate.writeFile(`${process.pid}\n`, "utf8");
        } catch (cause) {
          await candidate.close().catch(() => undefined);
          await unlink(lockPath).catch(() => undefined);
          throw cause;
        }
        handle = candidate;
        break;
      } catch (cause) {
        if (!hasCode(cause, "EEXIST")) {
          throw new SwarmError("fs", `Failed to lock swarm state: ${path}`, { cause });
        }

        let owner: string;
        let modifiedAt: number;
        try {
          const existing = await open(lockPath, "r");
          try {
            const [contents, metadata] = await Promise.all([
              existing.readFile("utf8"),
              existing.stat(),
            ]);
            owner = contents.trim();
            modifiedAt = metadata.mtimeMs;
          } finally {
            await existing.close().catch(() => undefined);
          }
        } catch (readError) {
          if (hasCode(readError, "ENOENT")) continue;
          if (Date.now() >= deadline) {
            throw new SwarmError("fs", `Failed to inspect swarm state lock: ${path}`, {
              cause: readError,
            });
          }
          await wait(lockRetryMs);
          continue;
        }

        const emptyOwnerIsFresh = owner === "" && Date.now() - modifiedAt < emptyLockGraceMs;
        const ownerPid = /^\d+$/u.test(owner) ? Number(owner) : Number.NaN;
        const validOwnerPid = Number.isSafeInteger(ownerPid) && ownerPid > 0;
        const ownerIsAlive = validOwnerPid ? await options.process.isAlive(ownerPid) : false;
        const stale = !emptyOwnerIsFresh && (!validOwnerPid || !ownerIsAlive);
        if (stale) {
          try {
            await unlink(lockPath);
            logger.warn("Reclaimed stale swarm state lock", {
              path: lockPath,
              owner: owner || "missing",
            });
          } catch (unlinkError) {
            if (!hasCode(unlinkError, "ENOENT")) {
              throw new SwarmError("fs", `Failed to reclaim swarm state lock: ${path}`, {
                cause: unlinkError,
              });
            }
          }
          continue;
        }

        if (Date.now() >= deadline) {
          throw new SwarmError(
            "fs",
            `Timed out waiting for swarm state lock after ${lockTimeoutMs}ms: ${path}`,
            { cause },
          );
        }
        await wait(lockRetryMs);
      }
    }

    try {
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  };

  const enqueue = async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = saveChain.catch(() => undefined).then(operation);
    saveChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    async load() {
      const active = transaction.getStore();
      return active ? structuredClone(active) : loadFromDisk();
    },

    async save(state) {
      const validated = validate(state);
      const write = saveChain.then(() =>
        files.writeTextAtomic(path, JSON.stringify(validated, null, 2)),
      );
      saveChain = write.catch(() => undefined);
      await write;
    },

    async mutate(mutation) {
      const active = transaction.getStore();
      if (active) {
        const result = await mutation(active);
        const validated = validate(active);
        await files.writeTextAtomic(path, JSON.stringify(validated, null, 2));
        return result;
      }

      return enqueue(() =>
        withFileLock(async () => {
          const next = await loadFromDisk();
          const result = await transaction.run(next, () => mutation(next));
          const validated = validate(next);
          await files.writeTextAtomic(path, JSON.stringify(validated, null, 2));
          return result;
        }),
      );
    },
  };
}
