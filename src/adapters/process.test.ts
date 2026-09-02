import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SwarmError } from "../core/errors.ts";
import { createFakeShell } from "../testing/fakeShell.ts";
import { createProcess } from "./process.ts";

describe("process adapter", () => {
  test("parses a process snapshot with leading spaces and commands containing spaces", async () => {
    const shell = createFakeShell([
      {
        match: (cmd, args) => cmd === "ps" && args[0] === "-axo",
        result: {
          stdout:
            "    1     0 /sbin/launchd\n  201     1 node /work tree/server.js --port 3000\n  305   201 /bin/zsh -l\n",
        },
      },
    ]);
    const processPort = createProcess(shell, "darwin");

    assert.deepEqual(await processPort.snapshot(), [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: 201, ppid: 1, command: "node /work tree/server.js --port 3000" },
      { pid: 305, ppid: 201, command: "/bin/zsh -l" },
    ]);
    assert.deepEqual(shell.calls[0], {
      cmd: "ps",
      args: ["-axo", "pid=,ppid=,command="],
      opts: undefined,
    });
  });

  test("returns descendants in breadth-first order and includes a present root", () => {
    const processPort = createProcess(createFakeShell(), "linux");
    const snapshot = [
      { pid: 1, ppid: 0, command: "root" },
      { pid: 2, ppid: 1, command: "first child" },
      { pid: 3, ppid: 1, command: "second child" },
      { pid: 4, ppid: 2, command: "grandchild" },
      { pid: 5, ppid: 99, command: "unrelated" },
    ];

    assert.deepEqual(
      processPort.descendants(1, snapshot).map(({ pid }) => pid),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      processPort.descendants(99, snapshot).map(({ pid }) => pid),
      [5],
    );
  });

  test("parses all listening ports in one lsof call and omits pids with no ports", async () => {
    const shell = createFakeShell([
      {
        match: (cmd) => cmd === "lsof",
        result: {
          stdout: [
            "p101",
            "n127.0.0.1:3000",
            "n*:3001",
            "p202",
            "n[::1]:8080",
            "n[::1]:8080",
            "p303",
          ].join("\n"),
        },
      },
    ]);
    const processPort = createProcess(shell, "linux");

    assert.deepEqual(
      await processPort.listeningPorts([101, 202, 303]),
      new Map([
        [101, [3000, 3001]],
        [202, [8080]],
      ]),
    );
    assert.deepEqual(shell.calls[0], {
      cmd: "lsof",
      args: ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", "101,202,303", "-F", "pn"],
      opts: undefined,
    });
  });

  test("skips lsof for no pids and accepts lsof's no-listeners exit", async () => {
    const emptyShell = createFakeShell();
    assert.deepEqual(await createProcess(emptyShell, "darwin").listeningPorts([]), new Map());
    assert.equal(emptyShell.calls.length, 0);

    const noListenersShell = createFakeShell([
      { match: (cmd) => cmd === "lsof", result: { code: 1, stdout: "" } },
    ]);
    assert.deepEqual(
      await createProcess(noListenersShell, "darwin").listeningPorts([101]),
      new Map(),
    );
  });

  test("reports process command failures as SwarmError", async () => {
    const shell = createFakeShell([
      {
        match: (cmd) => cmd === "ps",
        result: { code: 2, stderr: "ps unavailable\n" },
      },
    ]);
    await assert.rejects(createProcess(shell, "linux").snapshot(), (error: unknown) => {
      assert.ok(error instanceof SwarmError);
      assert.equal(error.code, "unsupported");
      assert.match(error.message, /ps unavailable/);
      return true;
    });
  });

  test("checks whether a pid is alive", async () => {
    const processPort = createProcess(createFakeShell(), process.platform);
    assert.equal(await processPort.isAlive(process.pid), true);
    assert.equal(await processPort.isAlive(2_147_483_647), false);
  });

  test("opens URLs detached with platform-specific argv", async () => {
    const darwinShell = createFakeShell();
    await createProcess(darwinShell, "darwin").openUrl("https://github.com/acme/app/pull/7");
    assert.deepEqual(darwinShell.detachedCalls, [
      { cmd: "open", args: ["https://github.com/acme/app/pull/7"], opts: undefined },
    ]);

    const linuxShell = createFakeShell();
    await createProcess(linuxShell, "linux").openUrl("https://github.com/acme/app/pull/7");
    assert.equal(linuxShell.detachedCalls[0]?.cmd, "xdg-open");
  });

  test("rejects non-GitHub hosts and unsafe URL schemes without launching", async () => {
    const shell = createFakeShell();
    const processPort = createProcess(shell, "darwin");

    for (const url of [
      "https://evil.example/phish",
      "http://github.com/acme/app/pull/7",
      "javascript:alert(1)",
      "file:///tmp/pr",
    ]) {
      await assert.rejects(
        processPort.openUrl(url),
        (error: unknown) => error instanceof SwarmError && error.code === "validation",
      );
    }
    assert.deepEqual(shell.detachedCalls, []);
  });
});
