import type { Logger } from "../core/ports.ts";

export interface LogEntry {
  level: "info" | "warn" | "error";
  scope: string;
  message: string;
  data?: unknown;
}

export type NullLogger = Logger & {
  entries: LogEntry[];
  scope: string;
};

export function createNullLogger(entries: LogEntry[] = [], scope = ""): NullLogger {
  const write = (level: LogEntry["level"], message: string, data?: unknown): void => {
    entries.push({ level, scope, message, data });
  };
  return {
    entries,
    scope,
    info(message, data) {
      write("info", message, data);
    },
    warn(message, data) {
      write("warn", message, data);
    },
    error(message, data) {
      write("error", message, data);
    },
    child(childScope) {
      return createNullLogger(entries, scope ? `${scope}:${childScope}` : childScope);
    },
    async flush() {},
  };
}

export const createFakeLogger = createNullLogger;
