import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import { SwarmError } from "../core/errors.ts";
import type { Config } from "../core/types.ts";
import { defaultConfig } from "../core/types.ts";
import { createFakeFiles } from "../testing/fakeFiles.ts";
import { createNullLogger } from "../testing/nullLogger.ts";
import { createConfigStore } from "./config.ts";

const configPath = "/swarm/config.json";
const home = "/Users/test/.swarm";

describe("config adapter", () => {
  test("writes and returns defaults when the config file is missing", async () => {
    const files = createFakeFiles();
    const store = createConfigStore(files, configPath, home, createNullLogger(), "/Users/test");

    const config = await store.load();

    assert.deepEqual(config, defaultConfig(home));
    assert.deepEqual(JSON.parse(files.texts.get(resolve(configPath)) ?? ""), config);
  });

  test("deep-merges partial config over defaults and expands home paths", async () => {
    const files = createFakeFiles({
      texts: {
        [configPath]: JSON.stringify({
          version: 1,
          reposDir: "~/source",
          worktreesDir: "~",
          sleep: { graceMs: 75 },
          github: {},
          ui: { statusRefreshMs: 5000 },
        }),
      },
    });
    const store = createConfigStore(files, configPath, home, createNullLogger(), "/Users/test");

    const config = await store.load();

    assert.equal(config.reposDir, "/Users/test/source");
    assert.equal(config.worktreesDir, "/Users/test");
    assert.equal(config.hotFreshnessMs, 60000);
    assert.equal(config.hotPoolSize, 1);
    assert.equal(config.hotRefreshIntervalMs, 300000);
    assert.equal(config.agent, "claude");
    assert.deepEqual(config.agentCommands, { claude: "claude", opencode: "opencode" });
    assert.equal(config.sleep.graceMs, 75);
    assert.equal(config.sleep.enabled, true);
    assert.deepEqual(config.sleep.keepAlive, defaultConfig(home).sleep.keepAlive);
    assert.deepEqual(config.windows, defaultConfig(home).windows);
    assert.equal(config.github.cacheTtlSeconds, 3600);
    assert.equal(config.github.prTtlSeconds, 90);
    assert.equal(config.github.cloneProtocol, "ssh");
    assert.equal(config.ui.statusRefreshMs, 5000);
    assert.equal(config.ui.remoteStatusRefreshMs, 10000);
    assert.deepEqual(config.hosts, {});
    assert.equal(config.defaultHost, "local");
  });

  test("resolves configured relative repository roots to absolute paths", async () => {
    const files = createFakeFiles({
      texts: {
        [configPath]: JSON.stringify({
          ...defaultConfig(home),
          reposDir: "relative-repos",
          worktreesDir: "relative-worktrees",
        }),
      },
    });
    const store = createConfigStore(files, configPath, home, createNullLogger());

    const config = await store.load();

    assert.equal(config.reposDir, resolve("relative-repos"));
    assert.equal(config.worktreesDir, resolve("relative-worktrees"));

    const defaulted = await createConfigStore(
      createFakeFiles(),
      configPath,
      "relative-home",
      createNullLogger(),
    ).load();
    assert.equal(defaulted.reposDir, resolve("relative-home/repos"));
    assert.equal(defaulted.worktreesDir, resolve("relative-home/worktrees"));
  });

  test("fills defaults around a partial agent command map", async () => {
    const files = createFakeFiles({
      texts: {
        [configPath]: JSON.stringify({
          ...defaultConfig(home),
          agentCommands: { claude: "claude --dangerously-skip-permissions" },
        }),
      },
    });
    const store = createConfigStore(files, configPath, home, createNullLogger());

    assert.deepEqual((await store.load()).agentCommands, {
      claude: "claude --dangerously-skip-permissions",
      opencode: "opencode",
    });
  });

  test("normalizes legacy agent window commands in memory", async () => {
    for (const command of ["cc", "claude", "opencode"]) {
      const files = createFakeFiles({
        texts: {
          [configPath]: JSON.stringify({
            ...defaultConfig(home),
            windows: [
              { name: "nvim", command: "nvim ." },
              { name: "cc", command },
              { name: "lg", command: "lazygit" },
            ],
          }),
        },
      });
      const store = createConfigStore(files, configPath, home, createNullLogger());

      const config = await store.load();

      assert.equal(config.windows[1]?.command, "{agent}", command);
    }
  });

  test("leaves legacy-looking commands alone when a placeholder already exists", async () => {
    const windows = [
      { name: "cc", command: "{agent}" },
      { name: "legacy", command: "claude" },
    ];
    const files = createFakeFiles({
      texts: { [configPath]: JSON.stringify({ ...defaultConfig(home), windows }) },
    });
    const store = createConfigStore(files, configPath, home, createNullLogger());

    assert.deepEqual((await store.load()).windows, windows);
  });

  test("validates and atomically saves config", async () => {
    const files = createFakeFiles();
    const store = createConfigStore(files, configPath, home, createNullLogger());
    const config = {
      ...defaultConfig(home),
      reposDir: "/repos",
      agentCommands: {
        claude: "claude --dangerously-skip-permissions",
        opencode: "opencode --model sonnet",
      },
    };

    await store.save(config);

    assert.deepEqual(JSON.parse(files.texts.get(resolve(configPath)) ?? ""), config);
    assert.equal(files.calls.at(-1)?.method, "writeTextAtomic");
    assert.deepEqual(await store.load(), config);
  });

  test("reports invalid config as a validation error", async () => {
    const files = createFakeFiles({ texts: { [configPath]: "{" } });
    const store = createConfigStore(files, configPath, home, createNullLogger());

    await assert.rejects(store.load(), (error: unknown) => {
      assert.ok(error instanceof SwarmError);
      assert.equal(error.code, "validation");
      assert.match(error.message, /Invalid JSON/);
      return true;
    });

    const invalid = { ...defaultConfig(home), version: 2 } as unknown as Config;
    await assert.rejects(store.save(invalid), (error: unknown) => {
      assert.ok(error instanceof SwarmError);
      assert.equal(error.code, "validation");
      return true;
    });

    await assert.rejects(
      store.save({ ...defaultConfig(home), hotFreshnessMs: -1 }),
      (error: unknown) => error instanceof SwarmError && error.code === "validation",
    );
    for (const patch of [
      { hotPoolSize: -1 },
      { hotPoolSize: 1.5 },
      { hotRefreshIntervalMs: -1 },
      { hotRefreshIntervalMs: 1.5 },
    ]) {
      await assert.rejects(
        store.save({ ...defaultConfig(home), ...patch }),
        (error: unknown) => error instanceof SwarmError && error.code === "validation",
      );
    }
  });
});
