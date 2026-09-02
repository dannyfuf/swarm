import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SwarmError } from "../core/errors.ts";
import type { RepoService } from "../core/services.ts";
import { createFixedClock } from "../testing/fixedClock.ts";
import { contexts, makeState } from "../testing/fixtures.ts";
import { createMemoryState } from "../testing/memoryState.ts";
import { createContextService } from "./contexts.ts";

function createRepoStub(
  onDelete: (id: string) => Promise<void> = async () => {},
): RepoService & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    async list() {
      return [];
    },
    async searchRemote() {
      return [];
    },
    async clone() {
      throw new SwarmError("unsupported", "not used");
    },
    async assign() {
      throw new SwarmError("unsupported", "not used");
    },
    async delete(id) {
      deleted.push(id);
      await onDelete(id);
    },
  };
}

describe("createContextService", () => {
  test("creates, updates, lists, and activates contexts from persisted state", async () => {
    const state = createMemoryState();
    const service = createContextService({
      state,
      clock: createFixedClock("2026-03-01T00:00:00.000Z"),
      repoService: createRepoStub(),
    });

    const created = await service.create({ name: "Client Work", owners: ["acme"] });
    assert.deepEqual(created, {
      id: "client-work",
      name: "Client Work",
      owners: ["acme"],
      createdAt: "2026-03-01T00:00:00.000Z",
    });
    assert.deepEqual(await service.list(), [created]);

    const updated = await service.update(created.id, {
      name: "Client Engineering",
      owners: ["acme", "tools"],
    });
    await service.setActive(created.id);
    assert.equal(updated.id, created.id);
    assert.equal(state.state.activeContextId, created.id);
    assert.deepEqual(state.state.contexts[0]?.owners, ["acme", "tools"]);

    const normalized = await service.create({ name: "Ops.Tools_v2", owners: [] });
    assert.equal(normalized.id, "ops-tools-v2");
  });

  test("rejects duplicate and invalid context ids", async () => {
    const state = createMemoryState(
      makeState({ contexts: [contexts[0]], repos: [], worktrees: [] }),
    );
    const service = createContextService({
      state,
      clock: createFixedClock(),
      repoService: createRepoStub(),
    });

    await assert.rejects(
      service.create({ name: "Buk", owners: [] }),
      (error) => error instanceof SwarmError && error.code === "conflict",
    );
    await assert.rejects(
      service.create({ name: "!!!", owners: [] }),
      (error) => error instanceof SwarmError && error.code === "validation",
    );
  });

  test("deletes all context repos before removing it and selects the first remaining context", async () => {
    const state = createMemoryState(makeState());
    const repoService = createRepoStub(async (id) => {
      const next = await state.load();
      next.repos = next.repos.filter((repo) => repo.id !== id);
      next.worktrees = next.worktrees.filter((worktree) => worktree.repoId !== id);
      await state.save(next);
    });
    const service = createContextService({ state, clock: createFixedClock(), repoService });
    const events: string[] = [];

    await service.delete("buk", (event) => events.push(event.type));

    assert.deepEqual(repoService.deleted, ["bukhr/payroll", "bukhr/platform"]);
    assert.deepEqual(
      state.state.contexts.map((context) => context.id),
      ["personal"],
    );
    assert.equal(state.state.activeContextId, "personal");
    assert.deepEqual(
      state.state.repos.map((repo) => repo.id),
      ["dannyfuf/dotfiles"],
    );
    assert.deepEqual(events, ["done"]);
  });
});
