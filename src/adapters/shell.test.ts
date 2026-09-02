import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { SwarmError } from "../core/errors.ts";
import { createNullLogger } from "./logger.ts";
import { createShell, type RunOptionsWithInput } from "./shell.ts";

describe("shell adapter", () => {
  test("collects UTF-8 output, writes input, merges env, and streams stderr lines", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "swarm-shell-"));
    try {
      const shell = createShell(createNullLogger());
      const lines: string[] = [];
      const script = [
        'process.stdin.setEncoding("utf8")',
        'let input = ""',
        'process.stdin.on("data", (chunk) => { input += chunk })',
        'process.stdin.on("end", () => {',
        '  process.stdout.write(process.cwd() + "|" + process.env.SWARM_TEST_ENV + "|" + input)',
        '  process.stderr.write("one\\r")',
        '  setTimeout(() => process.stderr.write("\\ntwo\\nlast"), 5)',
        "})",
      ].join(";");
      const result = await shell.run(process.execPath, ["-e", script], {
        cwd,
        env: { SWARM_TEST_ENV: "merged" },
        input: "hello",
        onStderrLine: (line) => lines.push(line),
      } as RunOptionsWithInput);

      assert.equal(result.code, 0);
      assert.equal(result.stdout, `${await realpath(cwd)}|merged|hello`);
      assert.equal(result.stderr, "one\r\ntwo\nlast");
      assert.deepEqual(lines, ["one", "two", "last"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("returns non-zero exits and timeouts without throwing", async () => {
    const shell = createShell(createNullLogger());
    const failed = await shell.run(process.execPath, ["-e", "process.exit(7)"]);
    assert.equal(failed.code, 7);

    const timedOut = await shell.run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      timeoutMs: 20,
    });
    assert.equal(timedOut.code, 124);
  });

  test("maps aborts and spawn failures to SwarmError", async () => {
    const shell = createShell(createNullLogger());
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      shell.run(process.execPath, ["-e", ""], { signal: controller.signal }),
      (error: unknown) => error instanceof SwarmError && error.code === "cancelled",
    );
    await assert.rejects(
      shell.run("/definitely/not/a/swarm-command", []),
      (error: unknown) => error instanceof SwarmError && error.code === "fs",
    );
  });
});
