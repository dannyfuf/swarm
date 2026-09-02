import type { Clock } from "../core/ports.ts";

export type FixedClock = Clock & {
  set(value: Date | string): void;
  advance(ms: number): void;
};

export function createFixedClock(value: Date | string = "2026-01-01T00:00:00.000Z"): FixedClock {
  let current = new Date(value);
  let nextHandle = 1;
  const intervals = new Map<
    number,
    { callback: () => void; intervalMs: number; nextRunAt: number }
  >();
  return {
    now() {
      return new Date(current);
    },
    set(next) {
      current = new Date(next);
    },
    setInterval(callback, intervalMs) {
      const handle = nextHandle;
      nextHandle += 1;
      intervals.set(handle, {
        callback,
        intervalMs,
        nextRunAt: current.getTime() + intervalMs,
      });
      return handle;
    },
    clearInterval(handle) {
      if (typeof handle === "number") intervals.delete(handle);
    },
    advance(ms) {
      const target = current.getTime() + ms;
      while (true) {
        const nextRunAt = Math.min(...[...intervals.values()].map((timer) => timer.nextRunAt));
        if (!Number.isFinite(nextRunAt) || nextRunAt > target) break;
        current = new Date(nextRunAt);
        for (const timer of [...intervals.values()]) {
          if (timer.nextRunAt !== nextRunAt) continue;
          timer.nextRunAt += timer.intervalMs;
          timer.callback();
        }
      }
      current = new Date(target);
    },
  };
}

export const createFakeClock = createFixedClock;
