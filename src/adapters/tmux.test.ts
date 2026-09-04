import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SwarmError } from "../core/errors.ts";
import { createFakeShell } from "../testing/fakeShell.ts";
import { createNullLogger } from "../testing/nullLogger.ts";
import { createTmux, tmuxLocaleEnv } from "./tmux.ts";

const PANE_FORMAT =
  "#{session_name}\t#{window_index}\t#{window_name}\t#{window_active}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}";
const SESSION_FORMAT =
  "#{session_name}\t#{session_attached}\t#{session_windows}\t#{session_created}\t#{session_activity}";

describe("tmux adapter", () => {
  test("parses and groups pane fixtures with paths containing spaces", async () => {
    const shell = createFakeShell([
      {
        match: (cmd, args) => cmd === "tmux" && args[1] === "list-panes",
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
      args: ["-u", "list-panes", "-a", "-F", PANE_FORMAT],
      opts: { env: { LC_CTYPE: "C.UTF-8" } },
    });
  });

  test("parses sessions and treats a missing tmux server as an empty list", async () => {
    const sessionShell = createFakeShell([
      {
        match: (_cmd, args) => args[1] === "list-sessions",
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
    assert.deepEqual(sessionShell.calls[0]?.args, ["-u", "list-sessions", "-F", SESSION_FORMAT]);

    const noServerShell = createFakeShell([
      {
        match: (_cmd, args) => args[1] === "list-sessions",
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
          switch (args[1]) {
            case "display-message":
              return args[2] === "-p" ? { stdout: "repo/feature\n" } : {};
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
    await tmux.newSession({
      name: "devbox/repo/feature",
      windowName: "ssh",
      command: "ssh -t -- devbox swarm open 'owner/repo#feature'",
    });
    assert.equal(
      await tmux.newWindow({ session: "repo/feature", name: "cc", cwd: "/work tree" }),
      4,
    );
    await tmux.sendKeys("%7", ["literal text", "Escape"], { enter: true });
    await tmux.swapWindows("repo/feature", 1, 4);
    await tmux.selectWindow("repo/feature", 1);
    await tmux.killWindow("repo/feature", 4);
    await tmux.killSession("repo/feature");
    await tmux.killSessionIfPresent("repo/feature");
    await tmux.setOption("devbox/repo/feature", "remain-on-exit", "on");
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
        ["tmux", ["-u", "display-message", "-p", "#{client_session}"]],
        ["tmux", ["-u", "list-sessions", "-F", SESSION_FORMAT]],
        ["tmux", ["-u", "list-panes", "-t", "=repo/feature", "-s", "-F", PANE_FORMAT]],
        ["tmux", ["-u", "has-session", "-t", "=repo/feature"]],
        [
          "tmux",
          ["-u", "new-session", "-d", "-s", "repo/feature", "-n", "nvim", "-c", "/work tree"],
        ],
        [
          "tmux",
          [
            "-u",
            "new-session",
            "-d",
            "-s",
            "devbox/repo/feature",
            "-n",
            "ssh",
            "ssh -t -- devbox swarm open 'owner/repo#feature'",
          ],
        ],
        [
          "tmux",
          [
            "-u",
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
        ["tmux", ["-u", "send-keys", "-t", "%7", "literal text", "Escape", "Enter"]],
        ["tmux", ["-u", "swap-window", "-d", "-s", "=repo/feature:1", "-t", "=repo/feature:4"]],
        ["tmux", ["-u", "select-window", "-t", "=repo/feature:1"]],
        ["tmux", ["-u", "kill-window", "-t", "=repo/feature:4"]],
        ["tmux", ["-u", "kill-session", "-t", "=repo/feature"]],
        ["tmux", ["-u", "kill-session", "-t", "=repo/feature"]],
        ["tmux", ["-u", "set-option", "-t", "=devbox/repo/feature:", "remain-on-exit", "on"]],
        ["tmux", ["-u", "switch-client", "-t", "=repo/feature"]],
        ["tmux", ["-u", "display-message", "hello there"]],
        ["tmux", ["-u", "attach-session", "-t", "=repo/feature"]],
      ],
    );
    // Every spawned command gets the same locale fallback when the host locale
    // is not UTF-8; attach replaces the process and inherits the environment.
    const spawned = shell.calls.slice(0, -1);
    assert.equal(spawned.length, 16);
    for (const call of spawned) assert.deepEqual(call.opts, { env: { LC_CTYPE: "C.UTF-8" } });
  });

  test("leaves the locale alone when the environment already selects UTF-8", async () => {
    const shell = createFakeShell([{ match: (cmd) => cmd === "tmux", result: {} }]);
    const tmux = createTmux(shell, createNullLogger(), { LANG: "en_US.UTF-8" });
    await tmux.displayMessage("hi");
    assert.deepEqual(shell.calls[0], {
      cmd: "tmux",
      args: ["-u", "display-message", "hi"],
      opts: undefined,
    });

    assert.equal(tmuxLocaleEnv({ LANG: "en_US.UTF-8" }), undefined);
    assert.equal(tmuxLocaleEnv({ LC_ALL: "C.utf8" }), undefined);
    assert.equal(tmuxLocaleEnv({ LC_CTYPE: "UTF-8", LANG: "C" }), undefined);
    assert.deepEqual(tmuxLocaleEnv({}), { LC_CTYPE: "C.UTF-8" });
    assert.deepEqual(tmuxLocaleEnv({ LC_CTYPE: "POSIX" }), { LC_CTYPE: "C.UTF-8" });
    assert.deepEqual(tmuxLocaleEnv({ LANG: "C" }), { LC_CTYPE: "C.UTF-8" });
  });

  test("does not query current session outside tmux and maps expected command outcomes", async () => {
    const shell = createFakeShell([
      {
        match: (_cmd, args) => args[1] === "has-session",
        result: { code: 1, stderr: "can't find session" },
      },
      {
        match: (_cmd, args) => args[1] === "kill-session",
        result: { code: 1, stderr: "session not found" },
      },
    ]);
    const tmux = createTmux(shell, createNullLogger(), {});
    assert.equal(tmux.insideTmux(), false);
    assert.equal(await tmux.currentSession(), null);
    assert.equal(await tmux.hasSession("missing/name"), false);
    await assert.doesNotReject(tmux.killSessionIfPresent("missing/name"));
    assert.equal(shell.calls.length, 2);
  });

  test("wraps tmux failures with stderr and the tmux error code", async () => {
    const logger = createNullLogger();
    const shell = createFakeShell([
      {
        match: (_cmd, args) => args[1] === "kill-session",
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
