import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SwarmError } from "./core/errors.ts";
import { defaultConfig } from "./core/types.ts";
import {
  exitTuiProcess,
  formatUnmountReport,
  main,
  parseArgv,
  resolveAgentName,
  runAgentCommand,
} from "./main.ts";
import { createFakeTmux } from "./testing/fakeTmux.ts";

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
    assert.deepEqual(parseArgv(["sleep", "--json", "payroll/main"]), {
      kind: "sleep",
      session: "payroll/main",
      json: true,
    });
    assert.deepEqual(parseArgv(["agent"]), { kind: "agent" });
    assert.deepEqual(parseArgv(["agent", "claude"]), { kind: "agent", agent: "claude" });
    assert.deepEqual(parseArgv(["agent", "opencode"]), { kind: "agent", agent: "opencode" });
    assert.equal(resolveAgentName(undefined, "opencode"), "opencode");
    assert.equal(resolveAgentName("claude", "opencode"), "claude");
  });

  test("parses host protocol commands with --json anywhere after the command", () => {
    assert.deepEqual(parseArgv(["list", "--json"]), { kind: "list", json: true });
    assert.deepEqual(parseArgv(["status"]), { kind: "status", json: false });
    assert.deepEqual(parseArgv(["delete", "--json", "bukhr/payroll#main"]), {
      kind: "delete",
      worktreeId: "bukhr/payroll#main",
      json: true,
    });
    assert.deepEqual(parseArgv(["kill", "bukhr/payroll#main", "--json"]), {
      kind: "kill",
      worktreeId: "bukhr/payroll#main",
      json: true,
    });
    assert.deepEqual(
      parseArgv([
        "create",
        "--branch",
        "feat/remote",
        "bukhr/payroll",
        "remote",
        "--json",
        "--base",
        "origin/main",
        "--url",
        "git@github.com:bukhr/payroll.git",
        "--default-branch",
        "main",
        "--hooks",
        '{"prepare":["npm ci"],"postCreate":["npm test"]}',
      ]),
      {
        kind: "create",
        repoId: "bukhr/payroll",
        slug: "remote",
        branch: "feat/remote",
        baseRef: "origin/main",
        url: "git@github.com:bukhr/payroll.git",
        defaultBranch: "main",
        hooks: { prepare: ["npm ci"], postCreate: ["npm test"] },
        json: true,
      },
    );
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
    assert.throws(
      () => parseArgv(["create", "bukhr/payroll", "slug", "--branch", "feat/x"]),
      (error: unknown) => error instanceof SwarmError && error.code === "validation",
    );
    assert.throws(
      () => parseArgv(["delete", "not-a-worktree", "--json"]),
      (error: unknown) => error instanceof SwarmError && error.code === "validation",
    );
  });

  test("returns exit code 1 and writes the JSON error envelope to stdout", async () => {
    const output: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      assert.equal(await main(["list", "unexpected", "--json"]), 1);
    } finally {
      process.stdout.write = originalWrite;
    }

    assert.deepEqual(JSON.parse(output.join("")), {
      protocol: 1,
      error: {
        kind: "validation",
        message:
          "Usage: swarm [command] Commands: open <owner/name#slug|repo/slug> sleep [session] [--json] agent [claude|opencode] list [--json] create <owner/name> <slug> --branch <name> --base <ref> [--url <url>] [--default-branch <name>] [--hooks <json>] [--json] delete <owner/name#slug> [--json] kill <owner/name#slug> [--json] status [--json] doctor --version",
      },
    });
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

test("agent popup starts the requested agent with its configured command", async () => {
  const tmux = createFakeTmux();
  const configValue = defaultConfig("/home/test/.swarm");
  configValue.agentCommands.opencode = "opencode --model sonnet";
  const attached: Array<{ session: string; env: NodeJS.ProcessEnv }> = [];

  const exitCode = await runAgentCommand(
    { tmux, configValue },
    "opencode",
    { TMUX: "/tmp/tmux/default,123,0" },
    async (session, env) => {
      attached.push({ session, env });
      return 7;
    },
  );

  assert.equal(exitCode, 7);
  assert.deepEqual(tmux.sentKeys, [
    {
      target: "=swarm-agent-opencode:0",
      keys: ["opencode --model sonnet"],
      enter: true,
    },
  ]);
  assert.deepEqual(attached, [
    { session: "swarm-agent-opencode", env: { TMUX: "/tmp/tmux/default,123,0" } },
  ]);
});
