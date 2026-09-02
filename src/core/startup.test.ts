import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStartupProfiler } from "./startup.ts";

test("startup profiler records monotonic marks and measured spans", async () => {
  const directory = mkdtempSync(join(tmpdir(), "swarm-startup-"));
  const output = join(directory, "profile.json");
  const times = [12, 15, 23];
  const profiler = createStartupProfiler(output, () => times.shift() ?? 23);

  try {
    profiler.mark("module.loaded");
    await profiler.measure("state.load", async () => "loaded");
    profiler.flush();
    profiler.flush();

    const report = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(report, {
      processStartMs: 0,
      entries: [
        { name: "module.loaded", startMs: 12 },
        { name: "state.load", startMs: 15, durationMs: 8 },
      ],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
