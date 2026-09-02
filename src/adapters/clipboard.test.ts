import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RunOptions } from "../core/ports.ts";
import { createFakeShell } from "../testing/fakeShell.ts";
import { createClipboard } from "./clipboard.ts";

interface InputOptions extends RunOptions {
  input?: string;
}

describe("clipboard adapter", () => {
  test("writes to pbcopy on macOS", async () => {
    const shell = createFakeShell([{ match: (cmd) => cmd === "pbcopy", result: {} }]);
    await createClipboard(shell, "darwin").copy("copied text");
    assert.deepEqual(
      shell.calls.map(({ cmd, args }) => [cmd, args]),
      [["pbcopy", []]],
    );
    assert.equal((shell.calls[0]?.opts as InputOptions | undefined)?.input, "copied text");
  });

  test("prefers wl-copy when present", async () => {
    const shell = createFakeShell([
      { match: (cmd) => cmd === "which", result: { stdout: "/usr/bin/wl-copy\n" } },
      { match: (cmd) => cmd === "wl-copy", result: {} },
    ]);
    await createClipboard(shell, "linux").copy("wayland");
    assert.deepEqual(
      shell.calls.map(({ cmd, args }) => [cmd, args]),
      [
        ["which", ["wl-copy"]],
        ["wl-copy", []],
      ],
    );
    assert.equal((shell.calls[1]?.opts as InputOptions | undefined)?.input, "wayland");
  });

  test("falls back to xclip", async () => {
    const shell = createFakeShell([
      { match: (cmd) => cmd === "which", result: { code: 1 } },
      { match: (cmd) => cmd === "xclip", result: {} },
    ]);
    await createClipboard(shell, "linux").copy("x11");
    assert.deepEqual(
      shell.calls.map(({ cmd, args }) => [cmd, args]),
      [
        ["which", ["wl-copy"]],
        ["xclip", ["-selection", "clipboard"]],
      ],
    );
    assert.equal((shell.calls[1]?.opts as InputOptions | undefined)?.input, "x11");
  });
});
