import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createLogger, createNullLogger } from "./logger.ts";

async function waitForLines(path: string, count: number): Promise<string[]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const lines = (await readFile(path, "utf8")).trim().split("\n");
      if (lines.length >= count) return lines;
    } catch {
      // The stream is opened lazily, so the file may not exist on the first attempt.
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${count} log lines`);
}

describe("logger adapter", () => {
  test("appends scoped JSON lines through one shared stream", async () => {
    const root = await mkdtemp(join(tmpdir(), "swarm-logger-"));
    const path = join(root, "swarm.log");
    try {
      const logger = createLogger(path, "app");
      logger.info("started", { pid: 42 });
      logger.child("git").warn("slow", { elapsed: 10 });
      logger.error("failed");

      const entries = (await waitForLines(path, 3)).map((line) => JSON.parse(line));
      assert.deepEqual(
        entries.map(({ level, scope, msg, data }) => ({ level, scope, msg, data })),
        [
          { level: "info", scope: "app", msg: "started", data: { pid: 42 } },
          { level: "warn", scope: "app:git", msg: "slow", data: { elapsed: 10 } },
          { level: "error", scope: "app", msg: "failed", data: undefined },
        ],
      );
      assert.equal(
        entries.every(({ ts }) => !Number.isNaN(Date.parse(ts))),
        true,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("never throws for unavailable paths or unserializable data", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const logger = createLogger("/definitely/missing/swarm/log.txt");
    assert.doesNotThrow(() => logger.info("circular", circular));

    const nullLogger = createNullLogger();
    assert.doesNotThrow(() => nullLogger.child("anything").error("ignored", circular));
  });
});
