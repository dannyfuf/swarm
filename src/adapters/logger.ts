import { createWriteStream, type WriteStream } from "node:fs";
import type { Logger } from "../core/ports.ts";

type LogLevel = "info" | "warn" | "error";

interface SharedStream {
  stream?: WriteStream;
  unavailable: boolean;
}

function joinScope(parent: string, child: string): string {
  return parent ? `${parent}:${child}` : child;
}

function createScopedLogger(filePath: string, scope: string, shared: SharedStream): Logger {
  const write = (level: LogLevel, msg: string, data?: unknown): void => {
    try {
      if (shared.unavailable) return;
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
  };
}

export function createLogger(filePath: string, scope = ""): Logger {
  return createScopedLogger(filePath, scope, { unavailable: false });
}

export function createNullLogger(): Logger {
  const logger: Logger = {
    info() {},
    warn() {},
    error() {},
    child() {
      return logger;
    },
  };
  return logger;
}
