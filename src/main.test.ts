import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SwarmError } from "./core/errors.ts";
import { formatUnmountReport, parseArgv } from "./main.ts";

describe("CLI parsing", () => {
  test("defaults to the TUI and recognizes simple commands", () => {
    assert.deepEqual(parseArgv([]), { kind: "tui" });
    assert.deepEqual(parseArgv(["--version"]), { kind: "version" });
    assert.deepEqual(parseArgv(["doctor"]), { kind: "doctor" });
  });

  test("parses open and optional sleep targets", () => {
    assert.deepEqual(parseArgv(["open", "bukhr/payroll#main"]), {
      kind: "open",
      target: "bukhr/payroll#main",
    });
    assert.deepEqual(parseArgv(["sleep"]), { kind: "sleep" });
    assert.deepEqual(parseArgv(["sleep", "payroll/main"]), {
      kind: "sleep",
      session: "payroll/main",
    });
  });

  test("rejects malformed invocations with a validation error", () => {
    assert.throws(
      () => parseArgv(["open"]),
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
});
