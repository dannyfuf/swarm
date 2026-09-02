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
import type { CloneJob, State, Worktree, WorktreeId, WorktreeStatus } from "../core/types.ts";
import { createFakeClipboard } from "../testing/fakeClipboard.ts";
import { createFixedClock, type FixedClock } from "../testing/fixedClock.ts";
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
  clock: FixedClock;
  behavior: {
    snapshot: StatusService["snapshot"];
    createWorktree: WorktreeService["create"];
    cloneRepo: RepoService["clone"];
    reconcileClones: RepoService["reconcileClones"];
    deleteWorktree: WorktreeService["delete"];
    open: SessionService["open"];
    setContext: ContextService["setActive"];
  };
  calls: {
    snapshots: Worktree[][];
    created: Array<{ input: Parameters<WorktreeService["create"]>[0]; onEvent?: OnEvent }>;
    cloned: Array<{ remote: Parameters<RepoService["clone"]>[0]; contextId: string }>;
    deletedWorktrees: WorktreeId[];
    opened: Array<{ worktree: Worktree; options?: { sleepPrevious?: boolean } }>;
    intervals: number[];
    clearedIntervals: unknown[];
    reconciliations: number;
  };
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
  const store = createRecordingStore(
    makeAppState({
      contexts: persisted.contexts,
      repos: persisted.repos,
      clones: persisted.clones,
      worktrees: persisted.worktrees,
      activeContextId: persisted.activeContextId,
    }),
  );
  const calls: Harness["calls"] = {
    snapshots: [],
    created: [],
    cloned: [],
    deletedWorktrees: [],
    opened: [],
    intervals: [],
    clearedIntervals: [],
    reconciliations: 0,
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
    async cloneRepo(remote, contextId) {
      return {
        id: remote.fullName,
        owner: remote.owner,
        name: remote.name,
        url: remote.sshUrl,
        contextId,
        defaultBranch: remote.defaultBranch,
        path: `/repos/${remote.owner}/${remote.name}`,
        stagingPath: `/repos/${remote.owner}/${remote.name}.staging`,
        logPath: `/logs/${remote.owner}-${remote.name}.log`,
        pid: 4242,
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "cloning",
      };
    },
    async reconcileClones() {
      return structuredClone(persisted.clones);
    },
    async deleteWorktree() {},
    async open() {},
    async setContext() {},
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
    async setActive(id) {
      return behavior.setContext(id);
    },
  };
  const repoService: RepoService = {
    async list() {
      return structuredClone(persisted.repos);
    },
    async searchRemote() {
      return structuredClone(remoteRepos);
    },
    async clone(remote, contextId, onEvent) {
      calls.cloned.push({ remote, contextId });
      return behavior.cloneRepo(remote, contextId, onEvent);
    },
    async reconcileClones() {
      calls.reconciliations += 1;
      return behavior.reconcileClones();
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

  const clock = createFixedClock("2026-01-01T00:00:00.000Z");
  const clockSetInterval = clock.setInterval.bind(clock);
  const clockClearInterval = clock.clearInterval.bind(clock);
  clock.setInterval = (handler, timeout) => {
    calls.intervals.push(timeout);
    return clockSetInterval(handler, timeout);
  };
  clock.clearInterval = (handle) => {
    calls.clearedIntervals.push(handle);
    clockClearInterval(handle);
  };

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
    clock,
    logger: createNullLogger(),
  });

  return {
    controller,
    store,
    clock,
    behavior,
    calls,
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
    harness.clock.advance(config.ui.statusRefreshMs);
    harness.clock.advance(config.ui.statusRefreshMs);
    assert.equal(harness.calls.snapshots.length, 1);

    first.resolve(new Map());
    await flush();
    harness.clock.advance(config.ui.statusRefreshMs);
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

  test("setContext failures are persisted as visible error toasts", async () => {
    const harness = createHarness();
    const failure = new SwarmError("fs", "Timed out waiting for swarm state lock");
    harness.behavior.setContext = async () => {
      throw failure;
    };

    await assert.rejects(() => harness.controller.setContext("personal"), failure);

    assert.equal(harness.store.getState().activeContextId, "buk");
    assert.deepEqual(harness.store.getState().toasts.at(-1), {
      id: "toast-1767225600000-1",
      level: "error",
      text: failure.message,
    });
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

  test("dispose during an in-flight clone never dispatches into the torn-down store", async () => {
    const harness = createHarness();
    const completion = deferred<CloneJob>();
    harness.behavior.cloneRepo = async () => completion.promise;

    const clone = harness.controller.cloneRepo(remoteRepos[0] as (typeof remoteRepos)[number]);
    await flush();
    assert.equal(harness.calls.cloned.length, 1);

    harness.controller.dispose();
    const actionsAtDispose = harness.store.actions.length;
    harness.store.dispatch = () => {
      throw new Error("dispatch after store teardown");
    };
    completion.resolve({
      id: "bukhr/benefits",
      owner: "bukhr",
      name: "benefits",
      url: "git@github.com:bukhr/benefits.git",
      contextId: "buk",
      defaultBranch: "main",
      path: "/repos/bukhr/benefits",
      stagingPath: "/repos/bukhr/benefits.staging",
      logPath: "/logs/clone-benefits.log",
      pid: 4242,
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "cloning",
    });

    await assert.doesNotReject(clone);
    assert.equal(harness.store.actions.length, actionsAtDispose);
  });

  test("polling promotes a completed background clone without a manual refresh", async () => {
    const clone: CloneJob = {
      id: "bukhr/benefits",
      owner: "bukhr",
      name: "benefits",
      url: "git@github.com:bukhr/benefits.git",
      contextId: "buk",
      defaultBranch: "main",
      path: "/repos/bukhr/benefits",
      stagingPath: "/repos/bukhr/benefits.staging",
      logPath: "/logs/clone-benefits.log",
      pid: 4242,
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "cloning",
    };
    const initial = makeState({ clones: [clone] });
    const harness = createHarness(initial);
    let pidAlive = true;
    let validGitPresent = false;
    harness.behavior.reconcileClones = async () => {
      if (!pidAlive && validGitPresent) {
        harness.setPersisted(
          makeState({
            clones: [],
            repos: [
              ...initial.repos,
              {
                id: clone.id,
                owner: clone.owner,
                name: clone.name,
                url: clone.url,
                contextId: clone.contextId,
                defaultBranch: clone.defaultBranch,
                path: clone.path,
                clonedAt: harness.clock.now().toISOString(),
                hooks: { postCreate: [] },
              },
            ],
          }),
        );
      }
      return [];
    };

    await harness.controller.init();
    assert.equal(harness.store.getState().clones[0]?.status, "cloning");
    assert.deepEqual(harness.calls.intervals, [2_000, config.ui.statusRefreshMs]);

    harness.clock.advance(1_999);
    await flush();
    assert.equal(harness.calls.reconciliations, 1);

    pidAlive = false;
    validGitPresent = true;
    harness.clock.advance(1);
    await flush();

    assert.equal(harness.store.getState().clones.length, 0);
    assert.ok(harness.store.getState().repos.some((repo) => repo.id === clone.id));
    assert.equal(harness.calls.reconciliations, 2);
    assert.equal(harness.calls.clearedIntervals.length, 1);
    harness.controller.dispose();
  });

  test("dispose prevents an in-flight clone poll from dispatching after teardown", async () => {
    const clone: CloneJob = {
      id: "bukhr/benefits",
      owner: "bukhr",
      name: "benefits",
      url: "git@github.com:bukhr/benefits.git",
      contextId: "buk",
      defaultBranch: "main",
      path: "/repos/bukhr/benefits",
      stagingPath: "/repos/bukhr/benefits.staging",
      logPath: "/logs/clone-benefits.log",
      pid: 4242,
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "cloning",
    };
    const harness = createHarness(makeState({ clones: [clone] }));
    const reconciliation = deferred<CloneJob[]>();
    let requests = 0;
    harness.behavior.reconcileClones = async () => {
      requests += 1;
      return requests === 1 ? [clone] : reconciliation.promise;
    };

    await harness.controller.init();
    harness.clock.advance(2_000);
    await flush();
    assert.equal(requests, 2);

    harness.controller.dispose();
    const actionsAtDispose = harness.store.actions.length;
    harness.store.dispatch = () => {
      throw new Error("dispatch after store teardown");
    };
    harness.setPersisted(makeState({ clones: [] }));
    reconciliation.resolve([]);
    await flush();

    assert.equal(harness.store.actions.length, actionsAtDispose);
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
