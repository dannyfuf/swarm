import { createWriteStream, type WriteStream } from "node:fs";
import type { Logger } from "../core/ports.ts";

type LogLevel = "info" | "warn" | "error";

interface SharedStream {
  stream?: WriteStream;
  unavailable: boolean;
  flushPromise?: Promise<void>;
  flushed: boolean;
}

function joinScope(parent: string, child: string): string {
  return parent ? `${parent}:${child}` : child;
}

function createScopedLogger(filePath: string, scope: string, shared: SharedStream): Logger {
  const write = (level: LogLevel, msg: string, data?: unknown): void => {
    try {
      if (shared.unavailable || shared.flushed) return;
      if (!shared.stream) {
        shared.stream = createWriteStream(filePath, { flags: "a" });
        shared.stream.on("error", () => {
          shared.unavailable = true;
        });
      }
      let line: string;
      try {
        line = JSON.stringify({ ts: new Date().toISOString(), level, scope, msg, data });
      } catch {
        line = JSON.stringify({ ts: new Date().toISOString(), level, scope, msg });
      }
      shared.stream.write(`${line}\n`);
    } catch {
      shared.unavailable = true;
    }
  };

  return {
    info(msg, data) {
      write("info", msg, data);
    },
    warn(msg, data) {
      write("warn", msg, data);
    },
    error(msg, data) {
      write("error", msg, data);
    },
    child(childScope) {
      return createScopedLogger(filePath, joinScope(scope, childScope), shared);
    },
    flush() {
      if (shared.flushPromise) return shared.flushPromise;
      shared.flushed = true;
      const stream = shared.stream;
      if (!stream) return Promise.resolve();
      shared.flushPromise = new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };
        stream.once("error", finish);
        stream.end(finish);
      });
      return shared.flushPromise;
    },
  };
}

export function createLogger(filePath: string, scope = ""): Logger {
  return createScopedLogger(filePath, scope, { unavailable: false, flushed: false });
}

export function createNullLogger(): Logger {
  const logger: Logger = {
    info() {},
    warn() {},
    error() {},
    child() {
      return logger;
    },
    async flush() {},
  };
  return logger;
}
