import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { SwarmError } from "../core/errors.ts";
import { createNullLogger } from "./logger.ts";
import { createShell, type RunOptionsWithInput } from "./shell.ts";

describe("shell adapter", () => {
  test("returns a detached child pid and redirects both output streams to a log", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "swarm-detached-"));
    const logPath = join(cwd, "clone.log");
    let pid: number | undefined;
    try {
      const shell = createShell(createNullLogger());
      pid = await shell.spawnDetached(
        process.execPath,
        [
          "-e",
          'process.stdout.write("clone stdout\\n"); process.stderr.write("clone stderr\\n"); setTimeout(() => {}, 1000)',
        ],
        { cwd, logPath },
      );

      assert.ok(pid > 0);

      let output = "";
      for (let attempt = 0; attempt < 20; attempt += 1) {
        output = await readFile(logPath, "utf8").catch(() => "");
        if (output.includes("clone stdout") && output.includes("clone stderr")) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      assert.match(output, /clone stdout/);
      assert.match(output, /clone stderr/);
    } finally {
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // The detached test process may have already exited.
        }
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("tracks a detached logged command through its exit", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "swarm-detached-hook-"));
    const logPath = join(cwd, "swarm.log");
    try {
      const shell = createShell(createNullLogger());
      const code = await shell.runDetachedLogged(
        process.execPath,
        ["-e", 'process.stdout.write("hook output\\n"); process.exitCode = 7'],
        { cwd, logPath },
      );

      assert.equal(code, 7);
      assert.equal(await readFile(logPath, "utf8"), "hook output\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

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
