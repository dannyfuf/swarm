import assert from "node:assert/strict";
import { access, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { SwarmError } from "../core/errors.ts";
import type { Logger } from "../core/ports.ts";
import type { State } from "../core/types.ts";
import { defaultState } from "../core/types.ts";
import { createFakeFiles } from "../testing/fakeFiles.ts";
import { createFakeProcess } from "../testing/fakeProcess.ts";
import { repos } from "../testing/fixtures.ts";
import { createNullLogger } from "../testing/nullLogger.ts";
import { createStateStore, type StateStoreOptions } from "./state.ts";

const statePath = "/swarm/state.json";

function stateWithContext(name: string): State {
  return {
    ...defaultState(),
    contexts: [
      {
        id: name.toLowerCase(),
        name,
        owners: [name.toLowerCase()],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function createTestStore(
  files = createFakeFiles(),
  path = statePath,
  logger: Logger = createNullLogger(),
  options: Partial<StateStoreOptions> = {},
) {
  const { process: processOverride, ...lockOptions } = options;
  const processPort = createFakeProcess([
    { pid: globalThis.process.pid, ppid: 0, command: "node --test" },
  ]);
  return createStateStore(files, path, logger, {
    process: processOverride ?? processPort,
    ...lockOptions,
  });
}

describe("state adapter", () => {
  test("loads default state when the state file is missing", async () => {
    const store = createTestStore();

    assert.deepEqual(await store.load(), defaultState());
  });

  test("loads pre-background-clone state with an empty clone job list", async () => {
    const legacy = defaultState();
    const { clones: _clones, ...withoutClones } = legacy;
    const files = createFakeFiles({ texts: { [statePath]: JSON.stringify(withoutClones) } });
    const store = createTestStore(files);

    assert.deepEqual((await store.load()).clones, []);
  });

  test("defaults legacy prepare hooks and rejects invalid hook commands", async () => {
    const repo = structuredClone(repos[0]);
    assert.ok(repo);
    const legacyRepo = {
      ...repo,
      hooks: { postCreate: repo.hooks.postCreate },
    };
    const legacy = { ...defaultState(), repos: [legacyRepo] };
    const files = createFakeFiles({ texts: { [statePath]: JSON.stringify(legacy) } });

    const loaded = await createTestStore(files).load();
    assert.deepEqual(loaded.repos[0]?.hooks, { prepare: [], postCreate: [] });

    const invalid = {
      ...legacy,
      repos: [{ ...legacyRepo, hooks: { prepare: "npm ci", postCreate: [] } }],
    };
    const invalidFiles = createFakeFiles({ texts: { [statePath]: JSON.stringify(invalid) } });
    await assert.rejects(
      createTestStore(invalidFiles).load(),
      (error: unknown) => error instanceof SwarmError && error.code === "validation",
    );
  });

  test("quarantines a broken state file before throwing validation details", async () => {
    const broken = JSON.stringify({ ...defaultState(), version: 2 });
    const files = createFakeFiles({ texts: { [statePath]: broken } });
    const logger = createNullLogger();
    const store = createTestStore(files, statePath, logger);

    await assert.rejects(store.load(), (error: unknown) => {
      assert.ok(error instanceof SwarmError);
      assert.equal(error.code, "validation");
      assert.match(error.message, /version/);
      return true;
    });

    const quarantined = [...files.texts.entries()].find(([path]) =>
      path.startsWith(resolve(`${statePath}.broken-`)),
    );
    assert.equal(quarantined?.[1], broken);
    assert.equal(files.texts.get(resolve(statePath)), undefined);
    assert.equal(logger.entries.at(-1)?.level, "warn");
  });

  test("validates and writes state atomically", async () => {
    const files = createFakeFiles();
    const store = createTestStore(files);
    const state = stateWithContext("Team");

    await store.save(state);

    assert.deepEqual(JSON.parse(files.texts.get(resolve(statePath)) ?? ""), state);
    assert.equal(files.calls.at(-1)?.method, "writeTextAtomic");
  });

  test("serializes concurrent saves with the last invocation winning", async () => {
    const files = createFakeFiles();
    const writeTextAtomic = files.writeTextAtomic.bind(files);
    const firstStarted = deferred();
    const releaseFirst = deferred();
    let writes = 0;
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    files.writeTextAtomic = async (path, text) => {
      writes += 1;
      activeWrites += 1;
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
      if (writes === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      await writeTextAtomic(path, text);
      activeWrites -= 1;
    };
    const store = createTestStore(files);
    const first = stateWithContext("First");
    const second = stateWithContext("Second");

    const firstSave = store.save(first);
    await firstStarted.promise;
    const secondSave = store.save(second);
    await Promise.resolve();

    assert.equal(maximumActiveWrites, 1);
    releaseFirst.resolve();
    await Promise.all([firstSave, secondSave]);
    assert.deepEqual(JSON.parse(files.texts.get(resolve(statePath)) ?? ""), second);
  });

  test("serializes complete load-modify-save mutations", async () => {
    const root = await mkdtemp(join(tmpdir(), "swarm-state-"));
    try {
      const path = join(root, "state.json");
      const files = createFakeFiles();
      const firstStore = createTestStore(files, path);
      const secondStore = createTestStore(files, path);
      await firstStore.save(defaultState());
      const firstEntered = deferred();
      const releaseFirst = deferred();

      const first = firstStore.mutate(async (state) => {
        firstEntered.resolve();
        await releaseFirst.promise;
        const context = stateWithContext("First").contexts[0];
        assert.ok(context);
        state.contexts.push(context);
      });
      await firstEntered.promise;
      const second = secondStore.mutate((state) => {
        const context = stateWithContext("Second").contexts[0];
        assert.ok(context);
        state.contexts.push(context);
      });
      releaseFirst.resolve();
      await Promise.all([first, second]);

      assert.deepEqual(
        (await firstStore.load()).contexts.map(({ id }) => id),
        ["first", "second"],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reclaims a lock owned by a dead process and removes it after mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "swarm-stale-lock-"));
    try {
      const path = join(root, "state.json");
      const lockPath = `${path}.lock`;
      const files = createFakeFiles();
      const deadProcess = createFakeProcess();
      const store = createTestStore(files, path, createNullLogger(), {
        process: deadProcess,
        lockTimeoutMs: 100,
      });
      await store.save(defaultState());
      await writeFile(lockPath, "2147483647\n", "utf8");

      await store.mutate((state) => {
        const context = stateWithContext("Recovered").contexts[0];
        assert.ok(context);
        state.contexts.push(context);
      });

      assert.deepEqual(
        (await store.load()).contexts.map(({ id }) => id),
        ["recovered"],
      );
      await assert.rejects(access(lockPath), { code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not steal a lock owned by a live process", async () => {
    const root = await mkdtemp(join(tmpdir(), "swarm-live-lock-"));
    try {
      const path = join(root, "state.json");
      const lockPath = `${path}.lock`;
      const files = createFakeFiles();
      const store = createTestStore(files, path, createNullLogger(), {
        lockTimeoutMs: 75,
        lockRetryMs: 5,
      });
      await store.save(defaultState());
      await writeFile(lockPath, `${process.pid}\n`, "utf8");

      await assert.rejects(
        store.mutate(() => undefined),
        (error: unknown) =>
          error instanceof SwarmError &&
          error.code === "fs" &&
          /Timed out waiting for swarm state lock/u.test(error.message),
      );
      await access(lockPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("protects a newly-created empty lock but reclaims it after the grace period", async () => {
    const root = await mkdtemp(join(tmpdir(), "swarm-empty-lock-"));
    try {
      const path = join(root, "state.json");
      const lockPath = `${path}.lock`;
      const files = createFakeFiles();
      const store = createTestStore(files, path, createNullLogger(), {
        lockTimeoutMs: 50,
        lockRetryMs: 5,
        emptyLockGraceMs: 1_000,
      });
      await store.save(defaultState());
      await writeFile(lockPath, "", "utf8");

      await assert.rejects(
        store.mutate(() => undefined),
        SwarmError,
      );
      await access(lockPath);

      const old = new Date(Date.now() - 2_000);
      await utimes(lockPath, old, old);
      await store.mutate((state) => {
        state.activeContextId = undefined;
      });
      await assert.rejects(access(lockPath), { code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
