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
    assert.equal(config.sleep.graceMs, 75);
    assert.equal(config.sleep.enabled, true);
    assert.deepEqual(config.sleep.keepAlive, defaultConfig(home).sleep.keepAlive);
    assert.deepEqual(config.windows, defaultConfig(home).windows);
    assert.equal(config.github.cacheTtlSeconds, 3600);
    assert.equal(config.github.prTtlSeconds, 90);
    assert.equal(config.github.cloneProtocol, "ssh");
    assert.equal(config.ui.statusRefreshMs, 5000);
  });

  test("validates and atomically saves config", async () => {
    const files = createFakeFiles();
    const store = createConfigStore(files, configPath, home, createNullLogger());
    const config = { ...defaultConfig(home), reposDir: "/repos" };

    await store.save(config);

    assert.deepEqual(JSON.parse(files.texts.get(resolve(configPath)) ?? ""), config);
    assert.equal(files.calls.at(-1)?.method, "writeTextAtomic");
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
  });
});
