import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SwarmError } from "./core/errors.ts";
import { exitTuiProcess, formatUnmountReport, parseArgv } from "./main.ts";

describe("CLI parsing", () => {
  test("defaults to the TUI and recognizes simple commands", () => {
    assert.deepEqual(parseArgv([]), { kind: "tui" });
    assert.deepEqual(parseArgv(["--version"]), { kind: "version" });
    assert.deepEqual(parseArgv(["doctor"]), { kind: "doctor" });
  });

  test("parses open, optional sleep, and agent targets", () => {
    assert.deepEqual(parseArgv(["open", "bukhr/payroll#main"]), {
      kind: "open",
      target: "bukhr/payroll#main",
    });
    assert.deepEqual(parseArgv(["sleep"]), { kind: "sleep" });
    assert.deepEqual(parseArgv(["sleep", "payroll/main"]), {
      kind: "sleep",
      session: "payroll/main",
    });
    assert.deepEqual(parseArgv(["agent", "claude"]), { kind: "agent", agent: "claude" });
    assert.deepEqual(parseArgv(["agent", "opencode"]), { kind: "agent", agent: "opencode" });
  });

  test("rejects malformed invocations with a validation error", () => {
    assert.throws(
      () => parseArgv(["open"]),
      (error: unknown) => error instanceof SwarmError && error.code === "validation",
    );
    assert.throws(
      () => parseArgv(["agent", "bogus"]),
      (error: unknown) => error instanceof SwarmError && error.code === "validation",
    );
  });

  test("prints unmount reports as stable JSON", () => {
    const text = formatUnmountReport({
      kept: [{ window: "cc", reason: "claude" }],
      closed: ["nvim"],
      sessionKilled: false,
    });
    assert.deepEqual(JSON.parse(text), {
      kept: [{ window: "cc", reason: "claude" }],
      closed: ["nvim"],
      sessionKilled: false,
    });
  });

  test("flushes stdout and stderr before explicitly exiting the TUI process", async () => {
    const events: string[] = [];

    await exitTuiProcess(7, {
      async flushStdout() {
        events.push("stdout");
      },
      async flushStderr() {
        events.push("stderr");
      },
      exit(code) {
        events.push(`exit:${code}`);
      },
    });

    assert.deepEqual(events.slice(0, 2).sort(), ["stderr", "stdout"]);
    assert.equal(events[2], "exit:7");
  });
});
