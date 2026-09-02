import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Action, AppState, Store } from "../core/app.ts";
import { SwarmError } from "../core/errors.ts";
import type { ConfigPort, StatePort, TmuxPort } from "../core/ports.ts";
import type {
  ContextService,
  OnEvent,
  RepoService,
  SessionService,
  StatusService,
  WorktreeService,
} from "../core/services.ts";
import type { State, Worktree, WorktreeId, WorktreeStatus } from "../core/types.ts";
import { createFakeClipboard } from "../testing/fakeClipboard.ts";
import { createFixedClock } from "../testing/fixedClock.ts";
import {
  config,
  contexts,
  makeAppState,
  makeState,
  remoteRepos,
  repos,
  worktrees,
} from "../testing/fixtures.ts";
import { createNullLogger } from "../testing/nullLogger.ts";
import { createController } from "./controller.ts";
import { createStore } from "./store.ts";

interface RecordingStore extends Store {
  actions: Action[];
}

interface Harness {
  controller: ReturnType<typeof createController>;
  store: RecordingStore;
  behavior: {
    snapshot: StatusService["snapshot"];
    createWorktree: WorktreeService["create"];
    deleteWorktree: WorktreeService["delete"];
    open: SessionService["open"];
  };
  calls: {
    snapshots: Worktree[][];
    created: Array<{ input: Parameters<WorktreeService["create"]>[0]; onEvent?: OnEvent }>;
    deletedWorktrees: WorktreeId[];
    opened: Array<{ worktree: Worktree; options?: { sleepPrevious?: boolean } }>;
    intervals: number[];
    clearedIntervals: Array<ReturnType<typeof globalThis.setInterval>>;
  };
  getTick(): (() => void) | undefined;
  setPersisted(state: State): void;
}

function createRecordingStore(initial: Partial<AppState>): RecordingStore {
  const inner = createStore(initial);
  const actions: Action[] = [];
  return {
    actions,
    getState: inner.getState,
    subscribe: inner.subscribe,
    dispatch(action) {
      actions.push(action);
      inner.dispatch(action);
    },
  };
}

function statusFor(worktree: Worktree, session: WorktreeStatus["session"] = "detached") {
  return {
    worktreeId: worktree.id,
    session,
    windows: [],
    running: session === "none" ? [] : ["claude"],
  } satisfies WorktreeStatus;
}

function createHarness(initial: State = makeState()): Harness {
  let persisted = structuredClone(initial);
  let tick: (() => void) | undefined;
  const store = createRecordingStore(
    makeAppState({
      contexts: persisted.contexts,
      repos: persisted.repos,
      worktrees: persisted.worktrees,
      activeContextId: persisted.activeContextId,
    }),
  );
  const calls: Harness["calls"] = {
    snapshots: [],
    created: [],
    deletedWorktrees: [],
    opened: [],
    intervals: [],
    clearedIntervals: [],
  };

  const behavior: Harness["behavior"] = {
    async snapshot(items) {
      return new Map(items.map((worktree) => [worktree.id, statusFor(worktree)]));
    },
    async createWorktree(input) {
      const created = worktrees[1];
      assert.ok(created);
      return { ...created, repoId: input.repoId, branch: input.branch };
    },
    async deleteWorktree() {},
    async open() {},
  };

  const state: StatePort = {
    async load() {
      return structuredClone(persisted);
    },
    async save(next) {
      persisted = structuredClone(next);
    },
  };
  const configPort: ConfigPort = {
    async load() {
      return structuredClone(config);
    },
    async save() {},
  };
  const contextService: ContextService = {
    async list() {
      return structuredClone(persisted.contexts);
    },
    async create(input) {
      return { ...contexts[0], ...input };
    },
    async update(id, patch) {
      const context = persisted.contexts.find((item) => item.id === id);
      if (!context) throw new SwarmError("not-found", `Context not found: ${id}`);
      return { ...context, ...patch };
    },
    async delete() {},
    async setActive() {},
  };
  const repoService: RepoService = {
    async list() {
      return structuredClone(persisted.repos);
    },
    async searchRemote() {
      return structuredClone(remoteRepos);
    },
    async clone() {
      const repo = repos[0];
      assert.ok(repo);
      return structuredClone(repo);
    },
    async assign(repoId, contextId) {
      const repo = persisted.repos.find((item) => item.id === repoId);
      if (!repo) throw new SwarmError("not-found", `Repo not found: ${repoId}`);
      return { ...repo, contextId };
    },
    async delete() {},
  };
  const worktreeService: WorktreeService = {
    async list() {
      return structuredClone(persisted.worktrees);
    },
    async remoteBranches() {
      return ["origin/main"];
    },
    async create(input, onEvent) {
      calls.created.push({ input, onEvent });
      return behavior.createWorktree(input, onEvent);
    },
    async delete(id, onEvent) {
      calls.deletedWorktrees.push(id);
      return behavior.deleteWorktree(id, onEvent);
    },
    async touch() {},
  };
  const sessionService: SessionService = {
    async mount() {},
    async open(worktree, options) {
      calls.opened.push({ worktree, options });
      return behavior.open(worktree, options);
    },
    async unmount() {
      return {
        kept: [{ window: "cc", reason: "claude" }],
        closed: ["nvim", "lg"],
        sessionKilled: false,
      };
    },
    async kill() {},
  };
  const statusService: StatusService = {
    async snapshot(items) {
      calls.snapshots.push(items);
      return behavior.snapshot(items);
    },
  };
  const tmux: TmuxPort = {
    insideTmux: () => true,
    async currentSession() {
      return "swarm/popup";
    },
    async listSessions() {
      return [];
    },
    async listWindows() {
      return [];
    },
    async hasSession() {
      return false;
    },
    async newSession() {},
    async newWindow() {
      return 0;
    },
    async sendKeys() {},
    async swapWindows() {},
    async selectWindow() {},
    async killWindow() {},
    async killSession() {},
    async switchClient() {},
    async attach(): Promise<never> {
      throw new SwarmError("unsupported", "Not used by controller tests");
    },
    async displayMessage() {},
  };

  const fakeSetInterval = ((
    handler: Parameters<typeof globalThis.setInterval>[0],
    timeout?: number,
  ) => {
    assert.equal(typeof handler, "function");
    tick = handler as () => void;
    calls.intervals.push(timeout ?? 0);
    return 42 as unknown as ReturnType<typeof globalThis.setInterval>;
  }) as typeof globalThis.setInterval;
  const fakeClearInterval = ((handle: ReturnType<typeof globalThis.setInterval>) => {
    calls.clearedIntervals.push(handle);
  }) as typeof globalThis.clearInterval;

  const controller = createController({
    store,
    contexts: contextService,
    repos: repoService,
    worktrees: worktreeService,
    sessions: sessionService,
    status: statusService,
    config: configPort,
    state,
    tmux,
    clipboard: createFakeClipboard(),
    clock: createFixedClock("2026-01-01T00:00:00.000Z"),
    logger: createNullLogger(),
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
  });

  return {
    controller,
    store,
    behavior,
    calls,
    getTick: () => tick,
    setPersisted(next) {
      persisted = structuredClone(next);
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      assert.ok(resolvePromise);
      resolvePromise(value);
    },
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("createController", () => {
  test("init hydrates before streaming statuses and starts polling", async () => {
    const harness = createHarness(makeState({ activeContextId: undefined }));
    await harness.controller.init();
    await flush();

    const state = harness.store.getState();
    assert.equal(state.loading, false);
    assert.equal(state.activeContextId, "buk");
    assert.equal(state.currentSession, "swarm/popup");
    assert.equal(state.config.reposDir, config.reposDir);
    assert.equal(Object.keys(state.statuses).length, worktrees.length);
    assert.deepEqual(harness.calls.intervals, [config.ui.statusRefreshMs]);
    assert.deepEqual(
      harness.store.actions.slice(0, 2).map(({ type }) => type),
      ["hydrate", "statuses"],
    );

    harness.controller.dispose();
    assert.equal(harness.calls.clearedIntervals.length, 1);
  });

  test("polling skips ticks while a snapshot is in flight", async () => {
    const harness = createHarness();
    const first = deferred<Map<WorktreeId, WorktreeStatus>>();
    const second = deferred<Map<WorktreeId, WorktreeStatus>>();
    let request = 0;
    harness.behavior.snapshot = async () => {
      request += 1;
      return request === 1 ? first.promise : second.promise;
    };

    await harness.controller.init();
    const tick = harness.getTick();
    assert.ok(tick);
    tick();
    tick();
    assert.equal(harness.calls.snapshots.length, 1);

    first.resolve(new Map());
    await flush();
    tick();
    assert.equal(harness.calls.snapshots.length, 2);
    second.resolve(new Map());
    await flush();
    harness.controller.dispose();
  });

  test("setContext updates the persisted context through the service and the store", async () => {
    const harness = createHarness();

    await harness.controller.setContext("personal");

    assert.equal(harness.store.getState().activeContextId, "personal");
    assert.equal(harness.store.getState().repoCursor, 0);
  });

  test("remoteBranches exposes the worktree service result", async () => {
    const harness = createHarness();

    assert.deepEqual(await harness.controller.remoteBranches("bukhr/payroll"), ["origin/main"]);
  });

  test("createWorktree emits progress, ends the operation, refreshes, and toasts", async () => {
    const harness = createHarness();
    harness.store.actions.length = 0;
    harness.behavior.createWorktree = async (input, onEvent) => {
      onEvent?.({ type: "step", label: "Fetching origin" });
      onEvent?.({ type: "step", label: "Copying tree" });
      onEvent?.({ type: "done" });
      const created = { ...worktrees[1], repoId: input.repoId, branch: input.branch };
      assert.ok(created.id);
      harness.setPersisted(makeState({ worktrees: [...worktrees, created] }));
      return created;
    };

    await harness.controller.createWorktree({
      repoId: "bukhr/payroll",
      branch: "Feat/Payroll Fix",
    });

    const operationActions = harness.store.actions.filter((action) => action.type.startsWith("op"));
    assert.deepEqual(
      operationActions.map(({ type }) => type),
      ["opStart", "opStep", "opStep", "opEnd"],
    );
    const start = operationActions[0];
    assert.equal(start?.type, "opStart");
    if (start?.type === "opStart") {
      assert.equal(start.op.targetId, "bukhr/payroll#feat-payroll-fix");
      assert.match(start.op.id, /^op-1767225600000-\d+$/);
    }
    assert.equal(harness.store.getState().operations.length, 0);
    assert.equal(harness.store.getState().toasts.at(-1)?.text, "Worktree Feat/Payroll Fix ready");
  });

  test("deduplicates concurrent operations for the same target", async () => {
    const harness = createHarness();
    const completion = deferred<Worktree>();
    harness.behavior.createWorktree = async () => completion.promise;
    const input = { repoId: "bukhr/payroll" as const, branch: "feat/same" };

    const first = harness.controller.createWorktree(input);
    await flush();
    await harness.controller.createWorktree(input);

    assert.equal(harness.calls.created.length, 1);
    assert.match(harness.store.getState().toasts.at(-1)?.text ?? "", /already in progress/);
    const completed = worktrees[0];
    assert.ok(completed);
    completion.resolve(completed);
    await first;
  });

  test("sleeping a worktree with no session reports that it is already asleep", async () => {
    const selected = worktrees[0];
    const repo = repos[0];
    assert.ok(selected && repo);
    const harness = createHarness(
      makeState({ repos: [repo], worktrees: [selected], activeContextId: "buk" }),
    );

    await harness.controller.sleepSelected();

    assert.equal(
      harness.store.getState().toasts.at(-1)?.text,
      `${selected.branch} is already asleep`,
    );
  });

  test("deleteSelected describes impact and deletes after confirmation", async () => {
    const selected = worktrees[0];
    const repo = repos[0];
    assert.ok(selected);
    assert.ok(repo);
    const harness = createHarness(
      makeState({ repos: [repo], worktrees: [selected], activeContextId: "buk" }),
    );
    harness.store.dispatch({ type: "statuses", statuses: { [selected.id]: statusFor(selected) } });

    await harness.controller.deleteSelected();
    const dialog = harness.store.getState().dialog;
    assert.equal(dialog?.kind, "confirm");
    if (dialog?.kind !== "confirm") return;
    assert.ok(dialog.body.some((line) => line.includes(selected.path)));
    assert.ok(dialog.body.some((line) => line.includes("detached")));
    assert.ok(dialog.body.some((line) => line.includes("claude")));

    dialog.onConfirm();
    assert.deepEqual(harness.calls.deletedWorktrees, [selected.id]);
    await flush();
    assert.equal(harness.store.getState().dialog, undefined);
  });

  test("openSelected forwards sleepPrevious", async () => {
    const selected = worktrees[0];
    const repo = repos[0];
    assert.ok(selected);
    assert.ok(repo);
    const harness = createHarness(
      makeState({ repos: [repo], worktrees: [selected], activeContextId: "buk" }),
    );

    await harness.controller.openSelected({ sleepPrevious: false });
    assert.deepEqual(harness.calls.opened, [
      { worktree: selected, options: { sleepPrevious: false } },
    ]);
  });

  test("service errors become toasts and openSelected rethrows", async () => {
    const selected = worktrees[0];
    const repo = repos[0];
    assert.ok(selected);
    assert.ok(repo);
    const harness = createHarness(
      makeState({ repos: [repo], worktrees: [selected], activeContextId: "buk" }),
    );
    const failure = new SwarmError("tmux", "tmux server unavailable");
    harness.behavior.open = async () => {
      throw failure;
    };

    await assert.rejects(() => harness.controller.openSelected(), failure);
    assert.deepEqual(harness.store.getState().toasts.at(-1), {
      id: "toast-1767225600000-1",
      level: "error",
      text: "tmux server unavailable",
    });
  });
});
