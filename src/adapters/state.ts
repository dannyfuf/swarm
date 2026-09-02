import { AsyncLocalStorage } from "node:async_hooks";
import { open, unlink } from "node:fs/promises";
import { z } from "zod";
import { SwarmError } from "../core/errors.ts";
import type { FilesPort, Logger, StatePort } from "../core/ports.ts";
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

export function createStateStore(
  files: FilesPort,
  path: string,
  logger: Logger,
): TransactionalStatePort {
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
    const deadline = Date.now() + 30_000;
    let handle: Awaited<ReturnType<typeof open>>;
    while (true) {
      try {
        handle = await open(lockPath, "wx");
        await handle.writeFile(`${process.pid}\n`, "utf8");
        break;
      } catch (cause) {
        if (
          typeof cause !== "object" ||
          cause === null ||
          !("code" in cause) ||
          cause.code !== "EEXIST" ||
          Date.now() >= deadline
        ) {
          throw new SwarmError("fs", `Failed to lock swarm state: ${path}`, { cause });
        }
        await wait(25);
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
