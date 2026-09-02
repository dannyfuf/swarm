import type { Clock } from "../core/ports.ts";

export type FixedClock = Clock & {
  set(value: Date | string): void;
};

export function createFixedClock(value: Date | string = "2026-01-01T00:00:00.000Z"): FixedClock {
  let current = new Date(value);
  return {
    now() {
      return new Date(current);
    },
    set(next) {
      current = new Date(next);
    },
  };
}

export const createFakeClock = createFixedClock;
