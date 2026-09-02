import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createFakeFiles } from "./fakeFiles.ts";
import { createFakeProcess } from "./fakeProcess.ts";
import { createFakeShell } from "./fakeShell.ts";
import { createFakeTmux } from "./fakeTmux.ts";

describe("test fakes", () => {
  test("FakeShell matches rules and records detached calls", async () => {
    const shell = createFakeShell([{ match: (cmd) => cmd === "git", result: { stdout: "ok\n" } }]);
    assert.deepEqual(await shell.run("git", ["status"]), {
      code: 0,
      stdout: "ok\n",
      stderr: "",
    });
    assert.equal((await shell.run("nope", [])).code, 127);
    await shell.spawnDetached("rm", ["-rf", "/tmp/item"]);
    assert.equal(shell.calls.length, 3);
    assert.equal(shell.detachedCalls.length, 1);
  });

  test("FakeFiles clones a whole tree prefix", async () => {
    const files = createFakeFiles({
      paths: ["/source", "/source/nested"],
      texts: { "/source/nested/file.txt": "hello" },
    });
    await files.cloneTree("/source", "/copy");
    assert.equal(await files.readText("/copy/nested/file.txt"), "hello");
    assert.equal(await files.exists("/copy/nested"), true);
  });

  test("FakeProcess finds a complete descendant tree including root", () => {
    const snapshot = [
      { pid: 1, ppid: 0, command: "shell" },
      { pid: 2, ppid: 1, command: "claude" },
      { pid: 3, ppid: 2, command: "worker" },
      { pid: 4, ppid: 0, command: "other" },
    ];
    const process = createFakeProcess(snapshot, new Map([[3, [3000]]]));
    assert.deepEqual(
      process.descendants(1, snapshot).map(({ pid }) => pid),
      [1, 2, 3],
    );
  });

  test("FakeTmux switches attachment state", async () => {
    const tmux = createFakeTmux({
      sessions: [
        { name: "one", attached: true, windows: 0, createdAt: 0, lastActivityAt: 0 },
        { name: "two", attached: false, windows: 0, createdAt: 0, lastActivityAt: 0 },
      ],
      currentSession: "one",
    });
    await tmux.switchClient("two");
    assert.equal(tmux.sessions.get("one")?.attached, false);
    assert.equal(tmux.sessions.get("two")?.attached, true);
    assert.deepEqual(tmux.switched, ["two"]);
  });

  test("FakeTmux tears down a session when its final window is killed", async () => {
    const tmux = createFakeTmux({
      sessions: [
        { name: "repo/one", attached: false, windows: 1, createdAt: 1, lastActivityAt: 1 },
      ],
      windows: [{ session: "repo/one", index: 3, name: "shell", active: true, panes: [] }],
    });

    await tmux.killWindow("repo/one", 3);

    assert.equal(await tmux.hasSession("repo/one"), false);
  });
});
