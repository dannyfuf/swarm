import { writeFileSync } from "node:fs";

export interface StartupEntry {
  name: string;
  startMs: number;
  durationMs?: number;
}

export interface StartupTiming {
  mark(name: string): void;
  measure<T>(name: string, operation: () => Promise<T>): Promise<T>;
}

export interface StartupProfiler extends StartupTiming {
  flush(): void;
}

export const noStartupTiming: StartupTiming = {
  mark() {},
  measure(_name, operation) {
    return operation();
  },
};

export function createStartupProfiler(
  outputPath: string | undefined,
  now: () => number = () => performance.now(),
): StartupProfiler {
  if (!outputPath) {
    return { ...noStartupTiming, flush() {} };
  }

  const entries: StartupEntry[] = [];
  let flushed = false;

  return {
    mark(name) {
      entries.push({ name, startMs: now() });
    },
    async measure(name, operation) {
      const startMs = now();
      try {
        return await operation();
      } finally {
        entries.push({ name, startMs, durationMs: now() - startMs });
      }
    },
    flush() {
      if (flushed) return;
      flushed = true;
      writeFileSync(
        outputPath,
        `${JSON.stringify({
          processStartMs: 0,
          entries: entries.sort((left, right) => left.startMs - right.startMs),
        })}\n`,
      );
    },
  };
}
