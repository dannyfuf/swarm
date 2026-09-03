import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  agentCommand,
  type Config,
  ConfigSchema,
  DEFAULT_AGENT_COMMANDS,
  defaultConfig,
  HostId,
  resolveWindowCommand,
  resolveWindows,
  worktreeHost,
} from "./types.ts";

describe("ConfigSchema", () => {
  test("defaults the configured agent to claude", () => {
    const input: Partial<Config> = structuredClone(defaultConfig("/home/test/.swarm"));
    delete input.agent;
    delete input.agentCommands;

    const parsed = ConfigSchema.parse(input);
    assert.equal(parsed.agent, "claude");
    assert.deepEqual(parsed.agentCommands, DEFAULT_AGENT_COMMANDS);
    assert.equal(defaultConfig("/home/test/.swarm").agent, "claude");
    assert.deepEqual(defaultConfig("/home/test/.swarm").agentCommands, DEFAULT_AGENT_COMMANDS);
  });

  test("fills missing commands in a partial agent command map", () => {
    const input: Record<string, unknown> = structuredClone(defaultConfig("/home/test/.swarm"));
    input.agentCommands = { claude: "claude --dangerously-skip-permissions" };

    assert.deepEqual(ConfigSchema.parse(input).agentCommands, {
      claude: "claude --dangerously-skip-permissions",
      opencode: "opencode",
    });
  });

  test("defaults remote host configuration and validates the selected host", () => {
    const defaults = defaultConfig("/home/test/.swarm");
    assert.deepEqual(defaults.hosts, {});
    assert.equal(defaults.defaultHost, "local");
    assert.equal(defaults.ui.remoteStatusRefreshMs, 10000);

    const configured = ConfigSchema.parse({
      ...defaults,
      hosts: { devbox: { ssh: "user@devbox" } },
      defaultHost: "devbox",
    });
    assert.deepEqual(configured.hosts.devbox, {
      ssh: "user@devbox",
      swarmCommand: "swarm",
    });
    assert.throws(() => ConfigSchema.parse({ ...defaults, defaultHost: "missing" }));
    assert.throws(() =>
      ConfigSchema.parse({ ...defaults, hosts: { local: { ssh: "localhost" } } }),
    );
  });
});

test("HostId reserves local and worktreeHost defaults absent placement to local", () => {
  assert.equal(HostId.parse("devbox-2"), "devbox-2");
  assert.equal(HostId.safeParse("local").success, false);
  assert.equal(HostId.safeParse("DevBox").success, false);
  assert.equal(worktreeHost({}), "local");
  assert.equal(worktreeHost({ host: "devbox" }), "devbox");
});

describe("agentCommand", () => {
  test("trims configured commands and falls back to the agent name when blank", () => {
    const config = defaultConfig("/home/test/.swarm");
    config.agentCommands.claude = "  claude --resume  ";
    config.agentCommands.opencode = "   ";

    assert.equal(agentCommand(config, "claude"), "claude --resume");
    assert.equal(agentCommand(config, "opencode"), "opencode");
  });
});

describe("window command resolution", () => {
  test("substitutes every agent placeholder without mutating the spec", () => {
    const spec = { name: "cc", command: "env TOOL={agent} {agent} --resume" };
    const config = {
      ...defaultConfig("/home/test/.swarm"),
      agent: "opencode" as const,
      agentCommands: { claude: "claude", opencode: "opencode --model sonnet" },
    };

    assert.deepEqual(resolveWindowCommand(spec, config), {
      name: "cc",
      command: "env TOOL=opencode --model sonnet opencode --model sonnet --resume",
    });
    assert.equal(spec.command, "env TOOL={agent} {agent} --resume");
  });

  test("resolves all configured windows with the selected agent", () => {
    const config = {
      ...defaultConfig("/home/test/.swarm"),
      agent: "opencode" as const,
      agentCommands: { claude: "claude", opencode: "opencode --model sonnet" },
    };

    assert.deepEqual(resolveWindows(config), [
      { name: "nvim", command: "nvim ." },
      { name: "cc", command: "opencode --model sonnet" },
      { name: "lg", command: "lazygit" },
    ]);
  });
});
