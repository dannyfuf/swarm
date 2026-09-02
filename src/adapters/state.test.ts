import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { SwarmError } from "../core/errors.ts";
import type { State } from "../core/types.ts";
import { defaultState } from "../core/types.ts";
import { createFakeFiles } from "../testing/fakeFiles.ts";
import { createNullLogger } from "../testing/nullLogger.ts";
import { createStateStore } from "./state.ts";

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

describe("state adapter", () => {
  test("loads default state when the state file is missing", async () => {
    const store = createStateStore(createFakeFiles(), statePath, createNullLogger());

    assert.deepEqual(await store.load(), defaultState());
  });

  test("quarantines a broken state file before throwing validation details", async () => {
    const broken = JSON.stringify({ ...defaultState(), version: 2 });
    const files = createFakeFiles({ texts: { [statePath]: broken } });
    const logger = createNullLogger();
    const store = createStateStore(files, statePath, logger);

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
    const store = createStateStore(files, statePath, createNullLogger());
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
    const store = createStateStore(files, statePath, createNullLogger());
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
      const firstStore = createStateStore(files, path, createNullLogger());
      const secondStore = createStateStore(files, path, createNullLogger());
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
});
