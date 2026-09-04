import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import { SwarmError } from "./core/errors.ts";
import { defaultConfig } from "./core/types.ts";
import {
  COMMAND_HELP,
  doctorChecks,
  exitTuiProcess,
  findWorktree,
  formatUnmountReport,
  localWorktreePath,
  main,
  parseArgv,
  resolveAgentName,
  runAgentCommand,
  USAGE,
} from "./main.ts";
import { createFakeRemoteHost } from "./testing/fakeRemoteHost.ts";
import { createFakeShell } from "./testing/fakeShell.ts";
import { createFakeTmux } from "./testing/fakeTmux.ts";
import { makeState, worktrees } from "./testing/fixtures.ts";

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
      worktreeIds: ["bukhr/payroll#main"],
      force: false,
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
    assert.deepEqual(parseArgv(["prune", "--json"]), {
      kind: "prune",
      dryRun: false,
      noFetch: false,
      killSessions: false,
      json: true,
    });
  });

  test("parses create defaults, inspect, multi-delete, prune, and path flags", () => {
    assert.deepEqual(parseArgv(["create", "dannyfuf/swarm", "feat-cli-completeness", "--json"]), {
      kind: "create",
      repoId: "dannyfuf/swarm",
      slug: "feat-cli-completeness",
      url: undefined,
      defaultBranch: undefined,
      hooks: { prepare: [], postCreate: [] },
      json: true,
    });
    assert.deepEqual(
      parseArgv(["create", "bukhr/payroll", "ticket-42", "--host", "devbox", "--json"]),
      {
        kind: "create",
        repoId: "bukhr/payroll",
        slug: "ticket-42",
        host: "devbox",
        url: undefined,
        defaultBranch: undefined,
        hooks: { prepare: [], postCreate: [] },
        json: true,
      },
    );
    assert.deepEqual(
      parseArgv(["inspect", "bukhr/payroll#main", "--fetch", "--repo", "bukhr/payroll", "--json"]),
      {
        kind: "inspect",
        worktreeIds: ["bukhr/payroll#main"],
        fetch: true,
        repoId: "bukhr/payroll",
        json: true,
      },
    );
    assert.deepEqual(
      parseArgv(["delete", "bukhr/payroll#main", "bukhr/platform#feat-api", "--force", "--json"]),
      {
        kind: "delete",
        worktreeIds: ["bukhr/payroll#main", "bukhr/platform#feat-api"],
        force: true,
        json: true,
      },
    );
    assert.deepEqual(
      parseArgv([
        "prune",
        "--dry-run",
        "--no-fetch",
        "--kill-sessions",
        "--repo",
        "bukhr/payroll",
        "--json",
      ]),
      {
        kind: "prune",
        dryRun: true,
        noFetch: true,
        killSessions: true,
        repoId: "bukhr/payroll",
        json: true,
      },
    );
    assert.deepEqual(parseArgv(["path", "bukhr/payroll#main"]), {
      kind: "path",
      worktreeId: "bukhr/payroll#main",
    });
  });

  test("parses --help for every command", () => {
    for (const command of Object.keys(COMMAND_HELP)) {
      assert.deepEqual(parseArgv([command, "--help"]), { kind: "help", command });
    }
    assert.deepEqual(parseArgv(["--help"]), { kind: "help" });
    assert.match(COMMAND_HELP.create, /only explicitly supplied --branch and --host/);
    assert.match(COMMAND_HELP.inspect, /head/);
    assert.match(COMMAND_HELP.delete, /cannot determine unique commits/);
    assert.match(COMMAND_HELP.prune, /--kill-sessions/);
  });

  test("prints command help to stdout and exits successfully", async () => {
    const output: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      assert.equal(await main(["inspect", "--help"]), 0);
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.equal(output.join(""), `${COMMAND_HELP.inspect}\n`);
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
      () => parseArgv(["create", "bukhr/payroll"]),
      (error: unknown) => error instanceof SwarmError && error.code === "validation",
    );
    assert.throws(
      () => parseArgv(["delete", "not-a-worktree", "--json"]),
      (error: unknown) => error instanceof SwarmError && error.code === "validation",
    );
    assert.throws(
      () => parseArgv(["prune", "--kill-sessions", "--kill-sessions"]),
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
        message: USAGE.replace(/\s+/gu, " ").trim(),
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

  test("resolves remote worktrees by id and proxy session name", () => {
    const source = worktrees[0];
    assert.ok(source);
    const remote = { ...source, host: "devbox" };
    const state = makeState({ worktrees: [remote] });
    assert.deepEqual(findWorktree(state, remote.id), remote);
    assert.deepEqual(findWorktree(state, "devbox/payroll/main"), remote);
  });

  test("returns only absolute local paths for the path command", () => {
    const source = worktrees[0];
    assert.ok(source);
    assert.equal(localWorktreePath({ ...source, path: "relative/path" }), resolve("relative/path"));
    assert.throws(
      () => localWorktreePath({ ...source, host: "devbox" }),
      (error: unknown) => error instanceof SwarmError && error.code === "unsupported",
    );
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

test("doctor checks configured host SSH and remote swarm protocol", async () => {
  const shell = createFakeShell([
    {
      match: (cmd) => cmd === "tmux",
      result: { stdout: "tmux 3.5\n" },
    },
    { match: (cmd) => cmd === "git", result: { stdout: "git version 2.50\n" } },
    { match: (cmd) => cmd === "gh", result: {} },
    { match: (cmd) => cmd === "cp", result: { stdout: "--reflink\n" } },
    { match: (cmd) => cmd === "ssh", result: {} },
  ]);
  const remoteHost = createFakeRemoteHost();
  remoteHost.script("devbox", "list", {
    code: 0,
    stdout: JSON.stringify({ protocol: 1, version: "swarm 0.1.0+remote" }),
    stderr: "",
  });
  const config = defaultConfig("/home/test/.swarm");
  config.hosts = { devbox: { ssh: "user@devbox", swarmCommand: "/opt/swarm" } };

  const checks = await doctorChecks({ shell, config, remoteHost });

  assert.deepEqual(shell.calls.find(({ cmd }) => cmd === "ssh")?.args, [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "--",
    "user@devbox",
    "true",
  ]);
  assert.deepEqual(remoteHost.calls[0], {
    hostId: "devbox",
    args: ["list", "--json"],
    timeoutMs: 5000,
  });
  assert.deepEqual(
    checks.slice(-2).map(({ name, ok, detail, hint }) => ({ name, ok, detail, hint })),
    [
      {
        name: "host devbox: ssh",
        ok: true,
        detail: "reachable",
        hint: "load your SSH key or fix the alias",
      },
      {
        name: "host devbox: swarm",
        ok: true,
        detail: "swarm 0.1.0+remote; protocol 1",
        hint: "install swarm on the host and make sure /opt/swarm resolves in a non-interactive shell",
      },
    ],
  );

  remoteHost.script("devbox", "list", {
    code: 0,
    stdout: JSON.stringify({ protocol: 9, version: "swarm future" }),
    stderr: "",
  });
  const mismatch = await doctorChecks({ shell, config, remoteHost });
  assert.equal(mismatch.at(-1)?.ok, false);
  assert.match(mismatch.at(-1)?.detail ?? "", /protocol 9 \(expected 1\)/);
});
