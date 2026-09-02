import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SwarmError } from "../core/errors.ts";
import { createFakeShell } from "../testing/fakeShell.ts";
import { createNullLogger } from "../testing/nullLogger.ts";
import { createTmux } from "./tmux.ts";

const PANE_FORMAT =
  "#{session_name}\t#{window_index}\t#{window_name}\t#{window_active}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}";
const SESSION_FORMAT =
  "#{session_name}\t#{session_attached}\t#{session_windows}\t#{session_created}\t#{session_activity}";

describe("tmux adapter", () => {
  test("parses and groups pane fixtures with paths containing spaces", async () => {
    const shell = createFakeShell([
      {
        match: (cmd, args) => cmd === "tmux" && args[0] === "list-panes",
        result: {
          stdout: [
            "app/feature\t1\teditor\t1\t%1\t101\tnvim\t/Users/test/Project With Spaces",
            "app/feature\t1\teditor\t1\t%2\t102\tnode server.js\t/Users/test/Project With Spaces",
            "app/feature\t2\tshell\t0\t%3\t103\tzsh\t/tmp/another path",
          ].join("\n"),
        },
      },
    ]);
    const tmux = createTmux(shell, createNullLogger(), {});

    assert.deepEqual(await tmux.listWindows(), [
      {
        session: "app/feature",
        index: 1,
        name: "editor",
        active: true,
        panes: [
          {
            id: "%1",
            pid: 101,
            currentCommand: "nvim",
            currentPath: "/Users/test/Project With Spaces",
          },
          {
            id: "%2",
            pid: 102,
            currentCommand: "node server.js",
            currentPath: "/Users/test/Project With Spaces",
          },
        ],
      },
      {
        session: "app/feature",
        index: 2,
        name: "shell",
        active: false,
        panes: [
          {
            id: "%3",
            pid: 103,
            currentCommand: "zsh",
            currentPath: "/tmp/another path",
          },
        ],
      },
    ]);
    assert.deepEqual(shell.calls[0], {
      cmd: "tmux",
      args: ["list-panes", "-a", "-F", PANE_FORMAT],
      opts: undefined,
    });
  });

  test("parses sessions and treats a missing tmux server as an empty list", async () => {
    const sessionShell = createFakeShell([
      {
        match: (_cmd, args) => args[0] === "list-sessions",
        result: {
          stdout: "app/one\t2\t3\t1700000000\t1700000100\napp/two\t0\t1\t1700000200\t1700000300\n",
        },
      },
    ]);
    const tmux = createTmux(sessionShell, createNullLogger(), {});
    assert.deepEqual(await tmux.listSessions(), [
      {
        name: "app/one",
        attached: true,
        windows: 3,
        createdAt: 1700000000,
        lastActivityAt: 1700000100,
      },
      {
        name: "app/two",
        attached: false,
        windows: 1,
        createdAt: 1700000200,
        lastActivityAt: 1700000300,
      },
    ]);
    assert.deepEqual(sessionShell.calls[0]?.args, ["list-sessions", "-F", SESSION_FORMAT]);

    const noServerShell = createFakeShell([
      {
        match: (_cmd, args) => args[0] === "list-sessions",
        result: { code: 1, stderr: "no server running on /tmp/tmux-501/default\n" },
      },
    ]);
    assert.deepEqual(await createTmux(noServerShell, createNullLogger(), {}).listSessions(), []);
  });

  test("uses exact targets and the specified argv for every command", async () => {
    const shell = createFakeShell([
      {
        match: (cmd) => cmd === "tmux",
        result: (_cmd, args) => {
          switch (args[0]) {
            case "display-message":
              return args[1] === "-p" ? { stdout: "repo/feature\n" } : {};
            case "list-sessions":
              return { stdout: "" };
            case "list-panes":
              return { stdout: "" };
            case "new-window":
              return { stdout: "4\n" };
            default:
              return {};
          }
        },
      },
    ]);
    const tmux = createTmux(shell, createNullLogger(), { TMUX: "/tmp/tmux,1,0" });

    assert.equal(tmux.insideTmux(), true);
    assert.equal(await tmux.currentSession(), "repo/feature");
    await tmux.listSessions();
    await tmux.listWindows("repo/feature");
    assert.equal(await tmux.hasSession("repo/feature"), true);
    await tmux.newSession({ name: "repo/feature", cwd: "/work tree", windowName: "nvim" });
    assert.equal(
      await tmux.newWindow({ session: "repo/feature", name: "cc", cwd: "/work tree" }),
      4,
    );
    await tmux.sendKeys("%7", ["literal text", "Escape"], { enter: true });
    await tmux.swapWindows("repo/feature", 1, 4);
    await tmux.selectWindow("repo/feature", 1);
    await tmux.killWindow("repo/feature", 4);
    await tmux.killSession("repo/feature");
    await tmux.switchClient("repo/feature");
    await tmux.displayMessage("hello there");
    await assert.rejects(tmux.attach("repo/feature"), (error: unknown) => {
      assert.ok(error instanceof SwarmError);
      assert.equal(error.code, "tmux");
      return true;
    });

    assert.deepEqual(
      shell.calls.map(({ cmd, args }) => [cmd, args]),
      [
        ["tmux", ["display-message", "-p", "#{client_session}"]],
        ["tmux", ["list-sessions", "-F", SESSION_FORMAT]],
        ["tmux", ["list-panes", "-t", "=repo/feature", "-s", "-F", PANE_FORMAT]],
        ["tmux", ["has-session", "-t", "=repo/feature"]],
        ["tmux", ["new-session", "-d", "-s", "repo/feature", "-n", "nvim", "-c", "/work tree"]],
        [
          "tmux",
          [
            "new-window",
            "-d",
            "-t",
            "=repo/feature:",
            "-n",
            "cc",
            "-c",
            "/work tree",
            "-P",
            "-F",
            "#{window_index}",
          ],
        ],
        ["tmux", ["send-keys", "-t", "%7", "literal text", "Escape", "Enter"]],
        ["tmux", ["swap-window", "-d", "-s", "=repo/feature:1", "-t", "=repo/feature:4"]],
        ["tmux", ["select-window", "-t", "=repo/feature:1"]],
        ["tmux", ["kill-window", "-t", "=repo/feature:4"]],
        ["tmux", ["kill-session", "-t", "=repo/feature"]],
        ["tmux", ["switch-client", "-t", "=repo/feature"]],
        ["tmux", ["display-message", "hello there"]],
        ["tmux", ["attach-session", "-t", "=repo/feature"]],
      ],
    );
  });

  test("does not query current session outside tmux and maps expected command outcomes", async () => {
    const shell = createFakeShell([
      {
        match: (_cmd, args) => args[0] === "has-session",
        result: { code: 1, stderr: "can't find session" },
      },
    ]);
    const tmux = createTmux(shell, createNullLogger(), {});
    assert.equal(tmux.insideTmux(), false);
    assert.equal(await tmux.currentSession(), null);
    assert.equal(await tmux.hasSession("missing/name"), false);
    assert.equal(shell.calls.length, 1);
  });

  test("wraps tmux failures with stderr and the tmux error code", async () => {
    const logger = createNullLogger();
    const shell = createFakeShell([
      {
        match: (_cmd, args) => args[0] === "kill-session",
        result: { code: 2, stderr: "permission denied\n" },
      },
    ]);
    const tmux = createTmux(shell, logger, {});
    await assert.rejects(tmux.killSession("repo/feature"), (error: unknown) => {
      assert.ok(error instanceof SwarmError);
      assert.equal(error.code, "tmux");
      assert.match(error.message, /permission denied/);
      return true;
    });
    assert.equal(logger.entries[0]?.scope, "tmux");
  });
});
