import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type Config,
  ConfigSchema,
  defaultConfig,
  resolveWindowCommand,
  resolveWindows,
} from "./types.ts";

describe("ConfigSchema", () => {
  test("defaults the configured agent to claude", () => {
    const input: Partial<Config> = structuredClone(defaultConfig("/home/test/.swarm"));
    delete input.agent;

    assert.equal(ConfigSchema.parse(input).agent, "claude");
    assert.equal(defaultConfig("/home/test/.swarm").agent, "claude");
  });
});

describe("window command resolution", () => {
  test("substitutes every agent placeholder without mutating the spec", () => {
    const spec = { name: "cc", command: "env TOOL={agent} {agent} --resume" };

    assert.deepEqual(resolveWindowCommand(spec, "opencode"), {
      name: "cc",
      command: "env TOOL=opencode opencode --resume",
    });
    assert.equal(spec.command, "env TOOL={agent} {agent} --resume");
  });

  test("resolves all configured windows with the selected agent", () => {
    const config = { ...defaultConfig("/home/test/.swarm"), agent: "opencode" as const };

    assert.deepEqual(resolveWindows(config), [
      { name: "nvim", command: "nvim ." },
      { name: "cc", command: "opencode" },
      { name: "lg", command: "lazygit" },
    ]);
  });
});
