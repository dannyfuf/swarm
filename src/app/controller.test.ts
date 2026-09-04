import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Action, AppState, Store } from "../core/app.ts";
import { SwarmError } from "../core/errors.ts";
import type { ConfigPort, StatePort, TmuxPort, UpdaterPort } from "../core/ports.ts";
import type {
  ContextService,
  OnEvent,
  PrService,
  RemoteHostService,
  RepoService,
  SessionService,
  StatusService,
  WorktreeService,
} from "../core/services.ts";
import type {
  CloneJob,
  Config,
  PrRepoSlice,
  PrTab,
  PullRequest,
  RepoId,
  State,
  Worktree,
  WorktreeId,
  WorktreeStatus,
} from "../core/types.ts";
import { createFakeClipboard } from "../testing/fakeClipboard.ts";
import { createFakeProcess } from "../testing/fakeProcess.ts";
import { createFakeUpdater } from "../testing/fakeUpdater.ts";
import { createFixedClock, type FixedClock } from "../testing/fixedClock.ts";
import {
  config,
  contexts,
  makeAppState,
  makeState,
  pullRequest,
  remoteRepos,
  repos,
  worktrees,
} from "../testing/fixtures.ts";
import type { NullLogger } from "../testing/nullLogger.ts";
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
  logger: NullLogger;
  behavior: {
    snapshot: StatusService["snapshot"];
    remoteBranches: WorktreeService["remoteBranches"];
    createWorktree: WorktreeService["create"];
    prepareHotCopy: WorktreeService["prepareHotCopy"];
    refreshPreparedCopy: WorktreeService["refreshPreparedCopy"];
    runPostCreateHooks: WorktreeService["runPostCreateHooks"];
    cloneRepo: RepoService["clone"];
    reconcileClones: RepoService["reconcileClones"];
    deleteWorktree: WorktreeService["delete"];
    open: SessionService["open"];
    setContext: ContextService["setActive"];
    findPr: PrService["findByBranch"];
    loadPr: PrService["load"];
    loadState: StatePort["load"];
    currentSession: TmuxPort["currentSession"];
    update: UpdaterPort["update"];
  };
  calls: {
    snapshots: Worktree[][];
    created: Array<{ input: Parameters<WorktreeService["create"]>[0]; onEvent?: OnEvent }>;
    prepared: Array<{ repoId: RepoId; onEvent?: OnEvent }>;
    refreshedPrepared: Array<{
      repoId: RepoId;
      opts?: Parameters<WorktreeService["refreshPreparedCopy"]>[1];
    }>;
    postCreateHooks: Array<{ worktreeId: WorktreeId; onEvent?: OnEvent }>;
    cloned: Array<{ remote: Parameters<RepoService["clone"]>[0]; contextId: string }>;
    deletedWorktrees: WorktreeId[];
    opened: Array<{ worktree: Worktree; options?: { sleepPrevious?: boolean } }>;
    intervals: number[];
    clearedIntervals: unknown[];
    reconciliations: number;
    creatingReconciliations: number;
    prLoads: Array<{ repoIds: RepoId[]; tab: PrTab; force?: boolean }>;
    prFinds: Array<{ repoId: RepoId; branch: string }>;
    clipboardCopies: string[];
    openedUrls: string[];
    updateRoots: string[];
    exitCodes: number[];
    worktreeDisposals: number;
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

function fakeRemoteHosts(overrides: Partial<RemoteHostService> = {}): RemoteHostService & {
  calls: {
    creates: Array<Parameters<RemoteHostService["create"]>>;
    syncs: string[];
    syncAll: number;
    snapshots: string[];
  };
} {
  const calls = {
    creates: [] as Array<Parameters<RemoteHostService["create"]>>,
    syncs: [] as string[],
    syncAll: 0,
    snapshots: [] as string[],
  };
  return {
    calls,
    async list() {
      return { protocol: 1, version: "swarm test", repos: [], worktrees: [] };
    },
    async create(...args) {
      calls.creates.push(args);
      if (overrides.create) return overrides.create(...args);
      const fallback = worktrees[0];
      assert.ok(fallback);
      return { created: true, worktree: { ...fallback, host: args[0] } };
    },
    async delete(hostId, worktreeId) {
      return (await overrides.delete?.(hostId, worktreeId)) ?? { ok: true };
    },
    async kill(hostId, worktreeId) {
      return overrides.kill?.(hostId, worktreeId);
    },
    async sleep(hostId, session) {
      if (overrides.sleep) return overrides.sleep(hostId, session);
      return { kept: [], closed: [], sessionKilled: true };
    },
    async status(hostId) {
      return (await overrides.status?.(hostId)) ?? [];
    },
    async inspect(hostId, worktreeIds, opts) {
      return (await overrides.inspect?.(hostId, worktreeIds, opts)) ?? [];
    },
    async sync(hostId) {
      calls.syncs.push(hostId);
      return (await overrides.sync?.(hostId)) ?? [];
    },
    async syncAll() {
      calls.syncAll += 1;
      return (await overrides.syncAll?.()) ?? [];
    },
    async remoteSnapshot(hostId) {
      calls.snapshots.push(hostId);
      return (await overrides.remoteSnapshot?.(hostId)) ?? new Map();
    },
    lastError(hostId) {
      return overrides.lastError?.(hostId);
    },
  };
}

function createHarness(
  initial: State = makeState(),
  options: {
    config?: Config;
    enableHotRefreshTimer?: boolean;
    remoteHosts?: RemoteHostService;
  } = {},
): Harness {
  let persisted = structuredClone(initial);
  const testConfig = structuredClone(options.config ?? config);
  const store = createRecordingStore(
    makeAppState({
      contexts: persisted.contexts,
      repos: persisted.repos,
      clones: persisted.clones,
      worktrees: persisted.worktrees,
      activeContextId: persisted.activeContextId,
      config: testConfig,
      loading: true,
    }),
  );
  const calls: Harness["calls"] = {
    snapshots: [],
    created: [],
    prepared: [],
    refreshedPrepared: [],
    postCreateHooks: [],
    cloned: [],
    deletedWorktrees: [],
    opened: [],
    intervals: [],
    clearedIntervals: [],
    reconciliations: 0,
    creatingReconciliations: 0,
    prLoads: [],
    prFinds: [],
    clipboardCopies: [],
    openedUrls: [],
    updateRoots: [],
    exitCodes: [],
    worktreeDisposals: 0,
  };

  const behavior: Harness["behavior"] = {
    async snapshot(items) {
      return new Map(items.map((worktree) => [worktree.id, statusFor(worktree)]));
    },
    async remoteBranches() {
      return ["origin/main"];
    },
    async createWorktree(input) {
      const created = worktrees[1];
      assert.ok(created);
      return { ...created, repoId: input.repoId, branch: input.branch };
    },
    async prepareHotCopy() {},
    async refreshPreparedCopy() {},
    async runPostCreateHooks() {},
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
    async findPr() {
      return undefined;
    },
    async loadPr() {},
    async loadState() {
      return structuredClone(persisted);
    },
    async currentSession() {
      return "swarm/popup";
    },
    async update(_installRoot, onEvent) {
      onEvent?.({ type: "step", label: "pulling main…" });
      onEvent?.({ type: "step", label: "installing dependencies…" });
      onEvent?.({ type: "step", label: "building…" });
    },
  };

  const state: StatePort = {
    async load() {
      return behavior.loadState();
    },
    async save(next) {
      persisted = structuredClone(next);
    },
  };
  const configPort: ConfigPort = {
    async load() {
      return structuredClone(testConfig);
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
    async reconcileCreating() {
      calls.creatingReconciliations += 1;
    },
    async coordinateRepoDeletion(_repoId, action) {
      await action();
    },
    dispose() {
      calls.worktreeDisposals += 1;
    },
    async list() {
      return structuredClone(persisted.worktrees);
    },
    async remoteBranches(repoId) {
      return behavior.remoteBranches(repoId);
    },
    prepareHotCopy(repoId, onEvent) {
      calls.prepared.push({ repoId, onEvent });
      return behavior.prepareHotCopy(repoId, onEvent);
    },
    async refreshPreparedCopy(repoId, opts) {
      calls.refreshedPrepared.push({ repoId, opts });
      return behavior.refreshPreparedCopy(repoId, opts);
    },
    async awaitPendingRefresh() {},
    async runPostCreateHooks(worktreeId, onEvent) {
      calls.postCreateHooks.push({ worktreeId, onEvent });
      return behavior.runPostCreateHooks(worktreeId, onEvent);
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
  const prService: PrService = {
    async findByBranch(repoId, branch) {
      calls.prFinds.push({ repoId, branch });
      return behavior.findPr(repoId, branch);
    },
    async load(repoIds, tab, opts) {
      calls.prLoads.push({ repoIds: [...repoIds], tab, force: opts.force });
      return behavior.loadPr(repoIds, tab, opts);
    },
  };
  const tmux: TmuxPort = {
    insideTmux: () => true,
    async currentSession() {
      return behavior.currentSession();
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
    async killSessionIfPresent() {},
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

  const clipboard = createFakeClipboard();
  calls.clipboardCopies = clipboard.copies;
  const process = createFakeProcess();
  calls.openedUrls = process.openedUrls;
  const updater = createFakeUpdater((installRoot, onEvent) =>
    behavior.update(installRoot, onEvent),
  );
  calls.updateRoots = updater.calls;
  const logger = createNullLogger();
  const controller = createController({
    store,
    contexts: contextService,
    repos: repoService,
    prs: prService,
    worktrees: worktreeService,
    sessions: sessionService,
    status: statusService,
    remoteHosts: options.remoteHosts,
    config: configPort,
    state,
    tmux,
    clipboard,
    process,
    clock,
    logger,
    updater,
    lifecycle: {
      requestExit(code) {
        calls.exitCodes.push(code);
      },
    },
    installRoot: "/install/swarm",
    enableHotRefreshTimer: options.enableHotRefreshTimer,
  });

  return {
    controller,
    store,
    clock,
    logger,
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
  reject(error: unknown): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      assert.ok(resolvePromise);
      resolvePromise(value);
    },
    reject(error) {
      assert.ok(rejectPromise);
      rejectPromise(error);
    },
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function seedPrs(
  harness: Harness,
  tab: PrTab,
  repoId: RepoId,
  prs: PullRequest[],
  overrides: Partial<PrRepoSlice> = {},
): void {
  harness.store.dispatch({
    type: "prSlice",
    tab,
    repoId,
    slice: { prs, fetchedAt: "2026-01-01T00:00:00.000Z", loading: false, ...overrides },
  });
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
    assert.equal(harness.calls.creatingReconciliations, 1);
    assert.deepEqual(harness.calls.intervals, [config.ui.statusRefreshMs]);
    const hydrateIndex = harness.store.actions.findIndex(({ type }) => type === "hydrate");
    const statusIndex = harness.store.actions.findIndex(({ type }) => type === "statuses");
    assert.ok(hydrateIndex >= 0 && statusIndex > hydrateIndex);

    harness.controller.dispose();
    assert.equal(harness.calls.clearedIntervals.length, 1);
    assert.equal(harness.calls.worktreeDisposals, 1);
  });

  test("startup remote sync runs after hydration without blocking init", async () => {
    const pending = deferred<Array<{ hostId: string; error?: SwarmError }>>();
    const remoteHosts = fakeRemoteHosts({ syncAll: () => pending.promise });
    const remoteConfig = {
      ...config,
      hosts: { devbox: { ssh: "devbox", swarmCommand: "swarm" } },
    };
    const harness = createHarness(makeState(), { config: remoteConfig, remoteHosts });

    await harness.controller.init();

    assert.equal(harness.store.getState().loading, false);
    assert.equal(remoteHosts.calls.syncAll, 1);
    assert.deepEqual(harness.calls.intervals, [
      config.ui.statusRefreshMs,
      config.ui.remoteStatusRefreshMs,
    ]);
    pending.resolve([{ hostId: "devbox" }]);
    await flush();
    harness.controller.dispose();
  });

  test("clamps the remote status timer to the local minimum refresh interval", async () => {
    const remoteHosts = fakeRemoteHosts();
    const harness = createHarness(makeState(), {
      config: {
        ...config,
        hosts: { devbox: { ssh: "devbox", swarmCommand: "swarm" } },
        ui: { ...config.ui, remoteStatusRefreshMs: 1 },
      },
      remoteHosts,
    });

    await harness.controller.init();

    assert.deepEqual(harness.calls.intervals, [config.ui.statusRefreshMs, 500]);
    harness.controller.dispose();
  });

  test("remote status timer merges host status and records changed errors once", async () => {
    const local = worktrees[0];
    const second = worktrees[1];
    assert.ok(local);
    assert.ok(second);
    const mirror = { ...local, host: "devbox" };
    let session: WorktreeStatus["session"] = "attached";
    let lastError: SwarmError | undefined;
    const remoteHosts = fakeRemoteHosts({
      async remoteSnapshot() {
        return new Map([[mirror.id, statusFor(mirror, session)]]);
      },
      lastError() {
        return lastError;
      },
    });
    const harness = createHarness(makeState({ worktrees: [second, mirror] }), {
      config: {
        ...config,
        hosts: { devbox: { ssh: "devbox", swarmCommand: "swarm" } },
      },
      remoteHosts,
    });
    await harness.controller.init();
    await flush();
    assert.equal(harness.store.getState().statuses[mirror.id]?.session, "attached");

    session = "unknown";
    lastError = new SwarmError("remote", "devbox unreachable: offline");
    harness.clock.advance(config.ui.remoteStatusRefreshMs);
    await flush();
    harness.clock.advance(config.ui.remoteStatusRefreshMs);
    await flush();

    assert.equal(harness.store.getState().statuses[mirror.id]?.session, "unknown");
    assert.equal(harness.store.getState().remoteErrors.devbox, "devbox unreachable: offline");
    assert.equal(
      harness.logger.entries.filter(({ message }) => message === "devbox unreachable: offline")
        .length,
      1,
    );
    harness.controller.dispose();
  });

  test("remote create uses host placement, syncs, refreshes status, and exposes progress", async () => {
    const remoteHosts = fakeRemoteHosts();
    const harness = createHarness(makeState(), {
      config: {
        ...config,
        hosts: { devbox: { ssh: "devbox", swarmCommand: "swarm" } },
        defaultHost: "devbox",
      },
      remoteHosts,
    });

    await harness.controller.createWorktree({
      repoId: "bukhr/payroll",
      branch: "feat/remote",
    });

    assert.deepEqual(remoteHosts.calls.creates[0], [
      "devbox",
      {
        repo: repos[0],
        slug: "feat-remote",
        branch: "feat/remote",
        baseRef: "origin/main",
      },
    ]);
    assert.deepEqual(remoteHosts.calls.syncs, ["devbox"]);
    assert.equal(remoteHosts.calls.syncAll, 1);
    assert.deepEqual(remoteHosts.calls.snapshots, ["devbox"]);
    assert.ok(
      harness.store.actions.some(
        (action) => action.type === "opStep" && action.step === "creating on devbox…",
      ),
    );
  });

  test("yankPath prefixes remote paths with the host id", async () => {
    const source = worktrees[0];
    assert.ok(source);
    const remote = { ...source, host: "devbox", path: "/srv/worktrees/payroll/main" };
    const harness = createHarness(makeState({ worktrees: [remote] }));

    await harness.controller.yankPath();

    assert.deepEqual(harness.calls.clipboardCopies, ["devbox:/srv/worktrees/payroll/main"]);
  });

  test("starts repo warm-ups after hydration with at most two repos active", async () => {
    const harness = createHarness();
    const preparation = deferred<void>();
    harness.behavior.prepareHotCopy = async () => preparation.promise;

    await harness.controller.init();

    assert.deepEqual(
      harness.calls.prepared.map(({ repoId }) => repoId),
      ["bukhr/payroll", "bukhr/platform"],
    );
    const hydrateIndex = harness.store.actions.findIndex(({ type }) => type === "hydrate");
    const warmIndex = harness.store.actions.findIndex(
      (action) => action.type === "opStart" && action.op.targetId?.startsWith("hot-copy:"),
    );
    assert.ok(hydrateIndex >= 0 && warmIndex > hydrateIndex);

    preparation.resolve();
    await flush();
    assert.deepEqual(
      harness.calls.prepared.map(({ repoId }) => repoId),
      ["bukhr/payroll", "bukhr/platform", "dannyfuf/dotfiles"],
    );
    harness.controller.dispose();
  });

  test("init starts both PR tabs in the background without awaiting them", async () => {
    const harness = createHarness();
    const pending = deferred<void>();
    harness.behavior.loadPr = async () => pending.promise;

    await harness.controller.init();

    assert.deepEqual(
      harness.calls.prLoads.map(({ repoIds, tab, force }) => ({ repoIds, tab, force })),
      [
        { repoIds: ["bukhr/payroll", "bukhr/platform"], tab: "mine", force: false },
        { repoIds: ["bukhr/payroll", "bukhr/platform"], tab: "review", force: false },
      ],
    );
    harness.controller.dispose();
    pending.resolve();
  });

  test("init hydrates cached state without waiting for shell-backed enrichment", async () => {
    const harness = createHarness();
    const session = deferred<string | null>();
    const reconciliation = deferred<CloneJob[]>();
    harness.behavior.currentSession = async () => session.promise;
    harness.behavior.reconcileClones = async () => reconciliation.promise;

    await harness.controller.init();

    assert.equal(harness.store.getState().loading, false);
    assert.deepEqual(harness.store.getState().worktrees, worktrees);
    assert.equal(harness.store.getState().currentSession, undefined);
    assert.equal(harness.calls.reconciliations, 1);

    session.resolve("swarm/popup");
    reconciliation.resolve([]);
    await flush();
    assert.equal(harness.store.getState().currentSession, "swarm/popup");
    harness.controller.dispose();
  });

  test("init failures become persistent UI errors and error toasts", async () => {
    const harness = createHarness();
    harness.behavior.loadState = async () => {
      throw new Error("state unavailable");
    };

    await assert.rejects(harness.controller.init(), /state unavailable/u);

    const state = harness.store.getState();
    assert.equal(state.loading, false);
    assert.equal(state.error, "state unavailable");
    assert.equal(state.toasts.at(-1)?.level, "error");
    assert.equal(state.toasts.at(-1)?.text, "state unavailable");
    harness.controller.dispose();
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

  test("setContext updates the store and background-loads both tabs for the new context", async () => {
    const harness = createHarness();
    const pending = deferred<void>();
    harness.behavior.loadPr = async () => pending.promise;
    harness.store.dispatch({
      type: "setScreen",
      screen: "main",
      scope: { kind: "repo", repoId: "bukhr/payroll" },
    });

    await harness.controller.setContext("personal");

    assert.equal(harness.store.getState().activeContextId, "personal");
    assert.equal(harness.store.getState().repoCursor, 0);
    assert.deepEqual(
      harness.calls.prLoads.map(({ repoIds, tab, force }) => ({ repoIds, tab, force })),
      [
        { repoIds: ["dannyfuf/dotfiles"], tab: "mine", force: false },
        { repoIds: ["dannyfuf/dotfiles"], tab: "review", force: false },
      ],
    );

    harness.store.dispatch({
      type: "setScreen",
      screen: "prs",
      scope: { kind: "repo", repoId: "dannyfuf/dotfiles" },
    });
    await harness.controller.setContext("buk");
    assert.deepEqual(harness.store.getState().prScope, { kind: "all" });
    assert.deepEqual(
      harness.calls.prLoads.slice(-2).map(({ repoIds, tab }) => ({ repoIds, tab })),
      [
        { repoIds: ["bukhr/payroll", "bukhr/platform"], tab: "mine" },
        { repoIds: ["bukhr/payroll", "bukhr/platform"], tab: "review" },
      ],
    );
    pending.resolve();
    await flush();
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

  test("pre-fetch refreshes its dialog generation and ignores an older same-repo open", async () => {
    const harness = createHarness();
    const firstRefresh = deferred<void>();
    harness.behavior.refreshPreparedCopy = async () => firstRefresh.promise;
    harness.behavior.remoteBranches = async () => ["origin/main", "origin/new-remote"];
    harness.store.dispatch({
      type: "openDialog",
      dialog: {
        kind: "create-worktree",
        repoId: "bukhr/payroll",
        generation: 1,
        branches: ["origin/main"],
        fetching: true,
        host: "local",
      },
    });

    harness.controller.refreshPreparedCopy("bukhr/payroll");
    assert.equal(harness.calls.refreshedPrepared.length, 1);
    assert.equal(harness.store.getState().dialog?.kind, "create-worktree");
    firstRefresh.resolve();
    await flush();

    const updated = harness.store.getState().dialog;
    assert.equal(updated?.kind, "create-worktree");
    if (updated?.kind === "create-worktree") {
      assert.deepEqual(updated.branches, ["origin/main", "origin/new-remote"]);
      assert.equal(updated.fetching, false);
    }

    const secondRefresh = deferred<void>();
    harness.behavior.refreshPreparedCopy = async () => secondRefresh.promise;
    harness.controller.refreshPreparedCopy("bukhr/payroll");
    harness.store.dispatch({ type: "closeDialog" });
    harness.store.dispatch({
      type: "openDialog",
      dialog: {
        kind: "create-worktree",
        repoId: "bukhr/payroll",
        generation: 2,
        branches: ["origin/reopened"],
        fetching: true,
        host: "local",
      },
    });
    secondRefresh.resolve();
    await flush();
    const reopened = harness.store.getState().dialog;
    assert.equal(reopened?.kind, "create-worktree");
    if (reopened?.kind === "create-worktree") {
      assert.deepEqual(reopened.branches, ["origin/reopened"]);
      assert.equal(reopened.fetching, true);
    }
  });

  test("dispose aborts an in-flight prepared-copy refresh", async () => {
    const harness = createHarness();
    harness.store.dispatch({
      type: "openDialog",
      dialog: {
        kind: "create-worktree",
        repoId: "bukhr/payroll",
        generation: 1,
        branches: ["origin/main"],
        fetching: true,
        host: "local",
      },
    });
    let refreshSignal: AbortSignal | undefined;
    harness.behavior.refreshPreparedCopy = async (_repoId, opts) => {
      refreshSignal = opts?.signal;
      assert.ok(refreshSignal);
      await new Promise<void>((_resolve, reject) => {
        refreshSignal?.addEventListener(
          "abort",
          () => reject(new SwarmError("cancelled", "refresh cancelled")),
          { once: true },
        );
      });
    };

    harness.controller.refreshPreparedCopy("bukhr/payroll");
    await flush();
    harness.controller.dispose();
    await flush();

    assert.equal(refreshSignal?.aborted, true);
  });

  test("createWorktree emits progress, ends the operation, refreshes, and toasts", async () => {
    const harness = createHarness();
    harness.store.actions.length = 0;
    harness.behavior.createWorktree = async (input, onEvent) => {
      onEvent?.({ type: "step", label: "Fetching origin" });
      onEvent?.({ type: "log", line: "Fetching origin 12ms" });
      onEvent?.({ type: "step", label: "Copying tree" });
      onEvent?.({ type: "log", line: "Copying tree 4ms" });
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

    const createStart = harness.store.actions.find(
      (action) =>
        action.type === "opStart" && action.op.targetId === "bukhr/payroll#feat-payroll-fix",
    );
    assert.equal(createStart?.type, "opStart");
    const createOperationId = createStart?.type === "opStart" ? createStart.op.id : undefined;
    const operationActions = harness.store.actions.filter((action) => {
      if (action.type === "opStart") return action.op.id === createOperationId;
      if (action.type === "opStep" || action.type === "opEnd") {
        return action.id === createOperationId;
      }
      return false;
    });
    assert.deepEqual(
      operationActions.map(({ type }) => type),
      ["opStart", "opStep", "opStep", "opStep", "opStep", "opEnd"],
    );
    assert.deepEqual(
      operationActions.flatMap((action) =>
        action.type === "opStep" && action.line !== undefined ? [action.line] : [],
      ),
      ["Fetching origin 12ms", "Copying tree 4ms"],
    );
    const start = operationActions[0];
    assert.equal(start?.type, "opStart");
    if (start?.type === "opStart") {
      assert.equal(start.op.targetId, "bukhr/payroll#feat-payroll-fix");
      assert.match(start.op.id, /^op-1767225600000-\d+$/);
    }
    assert.equal(harness.store.getState().operations.length, 0);
    assert.ok(
      harness.store
        .getState()
        .toasts.some(({ text }) => text === "Worktree Feat/Payroll Fix ready"),
    );
    assert.deepEqual(
      harness.calls.prepared.map(({ repoId }) => repoId),
      ["bukhr/payroll"],
    );
  });

  test("starts post-create hooks as a separate operation and allows opening meanwhile", async () => {
    const initial = makeState();
    const payroll = initial.repos.find(({ id }) => id === "bukhr/payroll");
    assert.ok(payroll);
    payroll.hooks.postCreate = ["npm install"];
    const harness = createHarness(initial);
    const hooks = deferred<void>();
    const created = initial.worktrees[0];
    assert.ok(created);
    harness.behavior.createWorktree = async () => created;
    harness.behavior.runPostCreateHooks = async (_worktreeId, onEvent) => {
      onEvent?.({ type: "step", label: "Running post-create hook 1/1" });
      onEvent?.({ type: "log", line: "$ npm install" });
      await hooks.promise;
    };

    const creation = harness.controller.createWorktree({
      repoId: "bukhr/payroll",
      branch: "feat/hooks",
    });
    await flush();

    assert.deepEqual(
      harness.calls.postCreateHooks.map(({ worktreeId }) => worktreeId),
      [created.id],
    );
    const hookOperation = harness.store
      .getState()
      .operations.find(({ targetId }) => targetId === `post-create:${created.id}`);
    assert.equal(hookOperation?.label, `Post-create hooks · ${created.slug}`);
    assert.equal(hookOperation?.step, "Running post-create hook 1/1");
    assert.equal(
      harness.store.getState().operations.some(({ label }) => label === "Creating worktree"),
      false,
    );

    await harness.controller.openSelected();
    assert.equal(harness.calls.opened.length, 1);
    assert.ok(
      harness.store
        .getState()
        .operations.some(({ targetId }) => targetId === `post-create:${created.id}`),
    );
    hooks.resolve();
    await creation;
    await flush();
  });

  test("starts replenishment as soon as a prepared copy is claimed", async () => {
    const harness = createHarness();
    const claimed = deferred<void>();
    const finishCreate = deferred<void>();
    const created = worktrees[0];
    assert.ok(created);
    harness.behavior.createWorktree = async (input, onEvent) => {
      onEvent?.({ type: "prepared-copy-claimed", repoId: input.repoId });
      claimed.resolve();
      await finishCreate.promise;
      return created;
    };

    const creation = harness.controller.createWorktree({
      repoId: "bukhr/payroll",
      branch: "feat/early-replenish",
    });
    await claimed.promise;
    await flush();
    assert.deepEqual(
      harness.calls.prepared.map(({ repoId }) => repoId),
      ["bukhr/payroll"],
    );

    finishCreate.resolve();
    await creation;
  });

  test("periodic prepared-copy refresh is opt-in for tests, sequential, and disableable", async () => {
    const enabledConfig = { ...config, hotRefreshIntervalMs: 1_000 };
    const harness = createHarness(makeState(), {
      config: enabledConfig,
      enableHotRefreshTimer: true,
    });
    let activeRefreshes = 0;
    let maximumActiveRefreshes = 0;
    harness.behavior.refreshPreparedCopy = async () => {
      activeRefreshes += 1;
      maximumActiveRefreshes = Math.max(maximumActiveRefreshes, activeRefreshes);
      await Promise.resolve();
      activeRefreshes -= 1;
    };
    await harness.controller.init();
    await flush();
    harness.calls.refreshedPrepared.length = 0;

    harness.clock.advance(999);
    await flush();
    assert.equal(harness.calls.refreshedPrepared.length, 0);
    harness.clock.advance(1);
    await flush();
    assert.deepEqual(
      harness.calls.refreshedPrepared.map(({ repoId, opts }) => [repoId, opts?.skipIfFresh]),
      [
        ["bukhr/payroll", true],
        ["bukhr/platform", true],
        ["dannyfuf/dotfiles", true],
      ],
    );
    assert.equal(maximumActiveRefreshes, 1);
    harness.controller.dispose();
    assert.equal(harness.calls.clearedIntervals.length, 2);

    const disabled = createHarness(makeState(), {
      config: { ...config, hotRefreshIntervalMs: 0 },
      enableHotRefreshTimer: true,
    });
    await disabled.controller.init();
    await flush();
    disabled.clock.advance(300_000);
    await flush();
    assert.equal(disabled.calls.refreshedPrepared.length, 0);
    assert.deepEqual(disabled.calls.intervals, [config.ui.statusRefreshMs]);
    disabled.controller.dispose();
  });

  test("a successful update reports progress and requests launcher restart code 75", async () => {
    const harness = createHarness();
    harness.store.actions.length = 0;

    await harness.controller.update();

    assert.deepEqual(harness.calls.updateRoots, ["/install/swarm"]);
    assert.deepEqual(harness.calls.exitCodes, [75]);
    assert.deepEqual(
      harness.store.actions
        .filter((action) => action.type.startsWith("op"))
        .map(({ type }) => type),
      ["opStart", "opStep", "opStep", "opStep", "opEnd"],
    );
  });

  test("a non-main update error stays visible and does not request a restart", async () => {
    const harness = createHarness();
    harness.behavior.update = async () => {
      throw new SwarmError("git", "update requires the main branch (current: feature)");
    };

    await harness.controller.update();

    assert.deepEqual(harness.calls.exitCodes, []);
    assert.equal(
      harness.store.getState().error,
      "update requires the main branch (current: feature)",
    );
    assert.equal(harness.store.getState().toasts.at(-1)?.level, "error");
  });

  test("a dirty-tree update error does not request a restart", async () => {
    const harness = createHarness();
    harness.behavior.update = async () => {
      throw new SwarmError("git", "update requires a clean working tree");
    };

    await harness.controller.update();

    assert.deepEqual(harness.calls.exitCodes, []);
    assert.equal(harness.store.getState().error, "update requires a clean working tree");
  });

  test("a failed build exposes the step and stderr tail without restarting", async () => {
    const harness = createHarness();
    harness.behavior.update = async (_root, onEvent) => {
      onEvent?.({ type: "step", label: "building…" });
      throw new SwarmError("unsupported", "Updating swarm: building failed: TypeScript exploded");
    };

    await harness.controller.update();

    assert.deepEqual(harness.calls.exitCodes, []);
    assert.equal(
      harness.store.getState().error,
      "Updating swarm: building failed: TypeScript exploded",
    );
    assert.equal(harness.store.getState().operations.length, 0);
  });

  test("ignores another update request while one is in flight", async () => {
    const harness = createHarness();
    const completion = deferred<void>();
    harness.behavior.update = async () => completion.promise;

    const first = harness.controller.update();
    await flush();
    const actionsBeforeSecondRequest = harness.store.actions.length;
    await harness.controller.update();

    assert.deepEqual(harness.calls.updateRoots, ["/install/swarm"]);
    assert.equal(harness.store.actions.length, actionsBeforeSecondRequest);
    assert.equal(
      harness.store.getState().toasts.some(({ text }) => text.includes("already in progress")),
      false,
    );
    completion.resolve();
    await first;
    assert.deepEqual(harness.calls.exitCodes, [75]);
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
    assert.ok(
      harness.store.getState().toasts.some(({ text }) => /already in progress/u.test(text)),
    );
    const completed = worktrees[0];
    assert.ok(completed);
    completion.resolve(completed);
    await first;
  });

  test("dispatches a background warm-up after create failure and reports warm-up failures", async () => {
    const harness = createHarness();
    harness.behavior.createWorktree = async () => {
      throw new SwarmError("git", "checkout failed");
    };
    harness.behavior.prepareHotCopy = async (_repoId, onEvent) => {
      const failure = new SwarmError("fs", "hot copy failed");
      onEvent?.({ type: "error", error: failure });
      throw failure;
    };

    await harness.controller.createWorktree({
      repoId: "bukhr/payroll",
      branch: "feat/failing",
    });
    await flush();

    assert.deepEqual(
      harness.calls.prepared.map(({ repoId }) => repoId),
      ["bukhr/payroll"],
    );
    assert.ok(harness.store.getState().toasts.some(({ text }) => text === "checkout failed"));
    assert.ok(harness.store.getState().toasts.some(({ text }) => text === "hot copy failed"));
    assert.ok(harness.logger.entries.some(({ message }) => message === "hot copy failed"));
  });

  test("deduplicates background warm-ups by repo", async () => {
    const harness = createHarness();
    const preparation = deferred<void>();
    harness.behavior.prepareHotCopy = async () => preparation.promise;

    await harness.controller.createWorktree({ repoId: "bukhr/payroll", branch: "feat/one" });
    await harness.controller.createWorktree({ repoId: "bukhr/payroll", branch: "feat/two" });

    assert.equal(harness.calls.prepared.length, 1);
    const warmOperations = harness.store
      .getState()
      .operations.filter(({ targetId }) => targetId === "hot-copy:bukhr/payroll");
    assert.equal(warmOperations.length, 1);
    preparation.resolve();
    await flush();
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
                hooks: { prepare: [], postCreate: [] },
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
    assert.ok(harness.calls.prepared.some(({ repoId }) => repoId === clone.id));
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
    await flush();
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

  test("openSelectedPr opens a linked worktree with the requested sleep behavior", async () => {
    const harness = createHarness();
    const linked = worktrees[1];
    assert.ok(linked);
    const pr = pullRequest({ repoId: linked.repoId, headRefName: linked.branch });
    seedPrs(harness, "mine", pr.repoId, [pr]);
    harness.store.dispatch({ type: "setScreen", screen: "prs" });

    await harness.controller.openSelectedPr({ keepPrevious: true });

    assert.deepEqual(harness.calls.opened, [
      { worktree: linked, options: { sleepPrevious: false } },
    ]);
    assert.equal(harness.calls.created.length, 0);
  });

  test("openSelectedPr creates and opens same-repo and fork worktrees", async () => {
    const sameRepoHarness = createHarness();
    const sameRepo = pullRequest({ number: 80, headRefName: "feat/new-pr" });
    seedPrs(sameRepoHarness, "review", sameRepo.repoId, [sameRepo]);
    sameRepoHarness.store.dispatch({ type: "setPrTab", tab: "review" });
    sameRepoHarness.store.dispatch({ type: "setScreen", screen: "prs" });

    await sameRepoHarness.controller.openSelectedPr({ keepPrevious: false });

    assert.deepEqual(sameRepoHarness.calls.created[0]?.input, {
      repoId: sameRepo.repoId,
      branch: sameRepo.headRefName,
      source: { kind: "pull", number: 80 },
    });
    assert.equal(sameRepoHarness.calls.opened[0]?.options?.sleepPrevious, true);

    const forkHarness = createHarness();
    const fork = pullRequest({ number: 81, isCrossRepository: true });
    seedPrs(forkHarness, "review", fork.repoId, [fork]);
    forkHarness.store.dispatch({ type: "setPrTab", tab: "review" });
    forkHarness.store.dispatch({ type: "setScreen", screen: "prs" });

    await forkHarness.controller.openSelectedPr({ keepPrevious: true });

    assert.deepEqual(forkHarness.calls.created[0]?.input, {
      repoId: fork.repoId,
      branch: "pr/81",
      source: { kind: "pull", number: 81 },
    });
    assert.equal(forkHarness.calls.opened[0]?.options?.sleepPrevious, false);
  });

  test("openPrs derives repo scope, preselects a worktree PR, and loads both tabs", async () => {
    const harness = createHarness();
    const linked = worktrees[1];
    assert.ok(linked);
    const other = pullRequest({ number: 90, updatedAt: "2026-03-01T00:00:00.000Z" });
    const pr = pullRequest({
      number: 91,
      headRefName: linked.branch,
      updatedAt: "2026-02-01T00:00:00.000Z",
    });
    seedPrs(harness, "mine", pr.repoId, [pr, other]);
    harness.store.dispatch({ type: "moveTo", pane: "repos", index: 1 });
    harness.store.dispatch({ type: "moveTo", pane: "worktrees", index: 1 });

    await harness.controller.openPrs();

    const state = harness.store.getState();
    assert.equal(state.screen, "prs");
    assert.equal(state.prTab, "mine");
    assert.deepEqual(state.prScope, { kind: "repo", repoId: "bukhr/payroll" });
    assert.equal(state.prCursor, 1);
    assert.deepEqual(
      harness.calls.prLoads.map(({ repoIds, tab }) => ({ repoIds, tab })),
      [
        { repoIds: ["bukhr/payroll"], tab: "mine" },
        { repoIds: ["bukhr/payroll"], tab: "review" },
      ],
    );
  });

  test("refreshPrs force-refreshes both tabs in scope", async () => {
    const harness = createHarness();
    harness.store.dispatch({
      type: "setScreen",
      screen: "prs",
      scope: { kind: "repo", repoId: "bukhr/platform" },
    });

    await harness.controller.refreshPrs({ force: true });

    assert.deepEqual(
      harness.calls.prLoads.map(({ repoIds, tab, force }) => ({ repoIds, tab, force })),
      [
        { repoIds: ["bukhr/platform"], tab: "mine", force: true },
        { repoIds: ["bukhr/platform"], tab: "review", force: true },
      ],
    );
  });

  test("browses and copies the selected PR URL", async () => {
    const harness = createHarness();
    const pr = pullRequest();
    seedPrs(harness, "mine", pr.repoId, [pr]);
    harness.store.dispatch({ type: "setScreen", screen: "prs" });

    await harness.controller.browseSelectedPr();
    await harness.controller.yankSelectedPr();

    assert.deepEqual(harness.calls.openedUrls, [pr.url]);
    assert.deepEqual(harness.calls.clipboardCopies, [pr.url]);
    assert.equal(harness.store.getState().toasts.at(-1)?.text, "Copied PR URL");
  });

  test("browses the selected worktree PR found by its repo and branch", async () => {
    const selected = worktrees[1];
    const repo = repos[0];
    assert.ok(selected && repo);
    const harness = createHarness(
      makeState({ repos: [repo], worktrees: [selected], activeContextId: "buk" }),
    );
    const pr = pullRequest({ repoId: selected.repoId, headRefName: selected.branch });
    harness.behavior.findPr = async () => pr;

    await harness.controller.browseSelectedWorktreePr();

    assert.deepEqual(harness.calls.prFinds, [{ repoId: selected.repoId, branch: selected.branch }]);
    assert.deepEqual(harness.calls.openedUrls, [pr.url]);
  });

  test("does nothing when the selected worktree branch has no PR", async () => {
    const selected = worktrees[1];
    const repo = repos[0];
    assert.ok(selected && repo);
    const harness = createHarness(
      makeState({ repos: [repo], worktrees: [selected], activeContextId: "buk" }),
    );

    await harness.controller.browseSelectedWorktreePr();

    assert.deepEqual(harness.calls.prFinds, [{ repoId: selected.repoId, branch: selected.branch }]);
    assert.deepEqual(harness.calls.openedUrls, []);
    assert.deepEqual(harness.store.getState().toasts, []);
    assert.equal(harness.store.getState().dialog, undefined);
    assert.deepEqual(harness.logger.entries, []);
  });

  test("reuses the cached worktree PR without a targeted lookup", async () => {
    const selected = worktrees[1];
    const repo = repos[0];
    assert.ok(selected && repo);
    const harness = createHarness(
      makeState({ repos: [repo], worktrees: [selected], activeContextId: "buk" }),
    );
    const pr = pullRequest({ repoId: selected.repoId, headRefName: selected.branch });
    seedPrs(harness, "mine", pr.repoId, [pr]);

    await harness.controller.browseSelectedWorktreePr();

    assert.deepEqual(harness.calls.prFinds, []);
    assert.deepEqual(harness.calls.openedUrls, [pr.url]);
  });
});
