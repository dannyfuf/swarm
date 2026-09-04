import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import { SwarmError } from "../core/errors.ts";
import type {
  ContextService,
  RemoteHostService,
  RepoService,
  WorktreeService,
} from "../core/services.ts";
import type { CloneJob, Worktree, WorktreeInspection } from "../core/types.ts";
import { createSessionService } from "../services/sessions.ts";
import { createStatusService } from "../services/status.ts";
import { createFakeProcess } from "../testing/fakeProcess.ts";
import { createFakeTmux } from "../testing/fakeTmux.ts";
import { createFixedClock } from "../testing/fixedClock.ts";
import { contexts, makeState, repos, worktrees } from "../testing/fixtures.ts";
import { createMemoryConfig } from "../testing/memoryConfig.ts";
import { createMemoryState } from "../testing/memoryState.ts";
import { createNullLogger } from "../testing/nullLogger.ts";
import {
  CLI_VERSION,
  handleProtocolCommand,
  type ProtocolDependencies,
  protocolErrorEnvelope,
} from "./protocol.ts";

function createHarness(initial = makeState()) {
  const state = createMemoryState(initial);
  const tmux = createFakeTmux();
  const createdInputs: Parameters<WorktreeService["create"]>[0][] = [];
  const postCreate: string[] = [];
  const deleted: string[] = [];

  const worktreeService: WorktreeService = {
    async reconcileCreating() {},
    async coordinateRepoDeletion(_repoId, action) {
      await action();
    },
    async list(repoId) {
      return state.state.worktrees.filter(
        (worktree) => repoId === undefined || worktree.repoId === repoId,
      );
    },
    async remoteBranches() {
      return [];
    },
    async prepareHotCopy() {},
    async refreshPreparedCopy() {},
    async awaitPendingRefresh() {},
    async create(input) {
      createdInputs.push(structuredClone(input));
      const repo = state.state.repos.find((candidate) => candidate.id === input.repoId);
      if (!repo) throw new SwarmError("not-found", `Repository not found: ${input.repoId}`);
      const slug = input.slug ?? "generated";
      const worktree: Worktree = {
        id: `${repo.id}#${slug}`,
        repoId: repo.id,
        slug,
        branch: input.branch,
        baseRef: input.baseRef ?? `origin/${repo.defaultBranch}`,
        path: `/home/test/.swarm/worktrees/${repo.id}/${slug}`,
        session: `${repo.name}/${slug}`,
        createdAt: "2026-09-03T00:00:00.000Z",
      };
      await state.mutate((next) => {
        next.worktrees.push(worktree);
      });
      return worktree;
    },
    async runPostCreateHooks(id) {
      postCreate.push(id);
    },
    async delete(id) {
      const worktree = state.state.worktrees.find((candidate) => candidate.id === id);
      if (!worktree) throw new SwarmError("not-found", `Worktree not found: ${id}`);
      deleted.push(id);
      await state.mutate((next) => {
        next.worktrees = next.worktrees.filter((worktree) => worktree.id !== id);
      });
    },
    async touch() {},
  };

  const repoService: RepoService = {
    async list(contextId) {
      return state.state.repos.filter(
        (repo) => contextId === undefined || repo.contextId === contextId,
      );
    },
    async searchRemote() {
      return [];
    },
    async clone() {
      throw new SwarmError("unsupported", "clone not configured in protocol test");
    },
    async reconcileClones() {
      return state.state.clones;
    },
    async assign(repoId, contextId) {
      const repo = state.state.repos.find((candidate) => candidate.id === repoId);
      if (!repo) throw new SwarmError("not-found", `Repository not found: ${repoId}`);
      return { ...repo, contextId };
    },
    async delete() {},
  };

  const contextService: ContextService = {
    async list() {
      return state.state.contexts;
    },
    async create(input) {
      const context = {
        id: "remote",
        name: input.name,
        owners: input.owners,
        createdAt: "2026-09-03T00:00:00.000Z",
      };
      await state.mutate((next) => {
        next.contexts.push(context);
      });
      return context;
    },
    async update(id) {
      const context = state.state.contexts.find((candidate) => candidate.id === id);
      if (!context) throw new SwarmError("not-found", `Context not found: ${id}`);
      return context;
    },
    async delete() {},
    async setActive() {},
  };

  const config = createMemoryConfig();
  const process = createFakeProcess();
  const sessions = createSessionService({
    tmux,
    process,
    config,
    state,
    worktrees: worktreeService,
    clock: createFixedClock(),
    logger: createNullLogger(),
  });
  const status = createStatusService({
    tmux,
    process,
    config,
    logger: createNullLogger(),
  });
  const inspections = {
    async inspect(input: { worktreeIds?: string[]; repoId?: string } = {}) {
      return state.state.worktrees
        .filter(
          (worktree) =>
            (input.worktreeIds === undefined || input.worktreeIds.includes(worktree.id)) &&
            (input.repoId === undefined || input.repoId === worktree.repoId),
        )
        .map((worktree) => ({
          worktreeId: worktree.id,
          repoId: worktree.repoId,
          host: worktree.host ?? "local",
          path: worktree.path,
          branch: worktree.branch,
          baseRef: worktree.baseRef,
          head: "1".repeat(40),
          targetBranch: "main",
          upstream: `origin/${worktree.branch}`,
          ahead: 0,
          behind: 0,
          upstreamGone: false,
          dirty: false,
          mergedIntoTarget: true,
          uniqueCommits: 0,
          published: true,
          merged: true,
          pr: null,
          session: "none" as const,
          running: [],
          inspectedAt: "2026-09-03T00:00:00.000Z",
          warnings: [],
          error: null,
        }));
    },
  };
  const deps: ProtocolDependencies = {
    state,
    contexts: contextService,
    repos: repoService,
    worktrees: worktreeService,
    sessions,
    status,
    inspections,
  };
  return { deps, state, tmux, createdInputs, postCreate, deleted };
}

function inspectionFor(
  worktree: Worktree,
  overrides: Partial<WorktreeInspection> = {},
): WorktreeInspection {
  return {
    worktreeId: worktree.id,
    repoId: worktree.repoId,
    host: worktree.host ?? "local",
    path: worktree.path,
    branch: worktree.branch,
    baseRef: worktree.baseRef,
    head: "1".repeat(40),
    targetBranch: "main",
    upstream: `origin/${worktree.branch}`,
    ahead: 0,
    behind: 0,
    upstreamGone: false,
    dirty: false,
    mergedIntoTarget: true,
    uniqueCommits: 0,
    published: true,
    merged: true,
    pr: null,
    session: "none",
    running: [],
    inspectedAt: "2026-09-03T00:00:00.000Z",
    warnings: [],
    error: null,
    ...overrides,
  };
}

describe("CLI protocol handlers", () => {
  test("list returns the exact versioned repository and worktree shape", async () => {
    const { deps } = createHarness();
    const response = await handleProtocolCommand({ kind: "list", json: true }, deps);

    assert.deepEqual(response, {
      protocol: 1,
      version: CLI_VERSION,
      repos,
      worktrees,
    });
  });

  test("list makes local repository and worktree paths absolute", async () => {
    const repo = repos[0];
    const local = worktrees[0];
    const source = worktrees[1];
    assert.ok(repo && local && source);
    const remote = { ...source, host: "devbox", path: "/srv/swarm/remote" };
    const { deps } = createHarness(
      makeState({
        repos: [{ ...repo, path: "relative-repo" }],
        worktrees: [{ ...local, path: "relative-worktree" }, remote],
      }),
    );

    const response = await handleProtocolCommand({ kind: "list", json: true }, deps);

    assert.equal("repos" in response ? response.repos[0]?.path : "", resolve("relative-repo"));
    assert.equal(
      "repos" in response ? response.worktrees[0]?.path : "",
      resolve("relative-worktree"),
    );
    assert.equal("repos" in response ? response.worktrees[1]?.path : "", remote.path);
  });

  test("create delegates an existing repository through worktree publication and hooks", async () => {
    const { deps, createdInputs, postCreate } = createHarness(
      makeState({ contexts: [contexts[0]], repos: [repos[0]], worktrees: [] }),
    );
    const response = await handleProtocolCommand(
      {
        kind: "create",
        repoId: "bukhr/payroll",
        slug: "remote-copy",
        branch: "feat/remote-copy",
        baseRef: "origin/main",
        hooks: { prepare: [], postCreate: [] },
        json: true,
      },
      deps,
    );

    assert.deepEqual(createdInputs, [
      {
        repoId: "bukhr/payroll",
        slug: "remote-copy",
        branch: "feat/remote-copy",
        baseRef: "origin/main",
      },
    ]);
    assert.deepEqual(postCreate, ["bukhr/payroll#remote-copy"]);
    assert.equal("worktree" in response ? response.worktree.host : "unexpected", undefined);
    assert.equal("created" in response ? response.created : "unexpected", true);
    assert.equal(
      "worktree" in response ? response.worktree.id : "unexpected",
      "bukhr/payroll#remote-copy",
    );
  });

  test("create idempotency compares only explicitly supplied branch and host flags", async () => {
    const source = worktrees[1];
    assert.ok(source);
    const existing = { ...source, host: "devbox" };
    assert.ok(existing);
    const idempotent = createHarness(makeState({ worktrees: [existing] }));
    const omitted = await handleProtocolCommand(
      {
        kind: "create",
        repoId: existing.repoId,
        slug: existing.slug,
        hooks: { prepare: [], postCreate: [] },
        json: true,
      },
      idempotent.deps,
    );

    assert.deepEqual(omitted, { protocol: 1, created: false, worktree: existing });
    const explicitMatch = await handleProtocolCommand(
      {
        kind: "create",
        repoId: existing.repoId,
        slug: existing.slug,
        branch: existing.branch,
        hooks: { prepare: [], postCreate: [] },
        json: true,
      },
      idempotent.deps,
    );
    assert.deepEqual(explicitMatch, { protocol: 1, created: false, worktree: existing });
    assert.deepEqual(idempotent.createdInputs, []);
    assert.deepEqual(idempotent.postCreate, []);

    const fresh = createHarness(makeState({ worktrees: [] }));
    await handleProtocolCommand(
      {
        kind: "create",
        repoId: "bukhr/payroll",
        slug: "ticket-42",
        branch: "ticket-42",
        hooks: { prepare: [], postCreate: [] },
        json: true,
      },
      fresh.deps,
    );
    assert.equal(fresh.createdInputs[0]?.baseRef, "origin/main");

    await assert.rejects(
      handleProtocolCommand(
        {
          kind: "create",
          repoId: existing.repoId,
          slug: existing.slug,
          branch: "different",
          hooks: { prepare: [], postCreate: [] },
          json: true,
        },
        idempotent.deps,
      ),
      (error: unknown) => error instanceof SwarmError && error.code === "conflict",
    );
    await assert.rejects(
      handleProtocolCommand(
        {
          kind: "create",
          repoId: existing.repoId,
          slug: existing.slug,
          host: "lab",
          hooks: { prepare: [], postCreate: [] },
          json: true,
        },
        idempotent.deps,
      ),
      (error: unknown) => error instanceof SwarmError && error.code === "conflict",
    );
  });

  test("create routes explicit remote placement without forwarding host recursively", async () => {
    const harness = createHarness(makeState({ worktrees: [] }));
    const source = worktrees[1];
    assert.ok(source);
    const remote = { ...source, host: "devbox" };
    const createCalls: Parameters<RemoteHostService["create"]>[] = [];
    harness.deps.remoteHosts = {
      async list() {
        return { protocol: 1, version: "swarm test", repos: [], worktrees: [] };
      },
      async create(...args) {
        createCalls.push(args);
        return { created: true, worktree: { ...remote, host: undefined } };
      },
      async delete() {
        return { ok: true };
      },
      async kill() {},
      async sleep() {
        return { kept: [], closed: [], sessionKilled: true };
      },
      async status() {
        return [];
      },
      async inspect() {
        return [];
      },
      async sync() {
        return [remote];
      },
      async syncAll() {
        return [];
      },
      async remoteSnapshot() {
        return new Map();
      },
      lastError() {
        return undefined;
      },
    };

    const response = await handleProtocolCommand(
      {
        kind: "create",
        repoId: source.repoId,
        slug: source.slug,
        branch: source.branch,
        host: "devbox",
        hooks: { prepare: [], postCreate: [] },
        json: true,
      },
      harness.deps,
    );

    assert.equal("created" in response && response.created, true);
    assert.equal("worktree" in response ? response.worktree.host : undefined, "devbox");
    assert.deepEqual(createCalls[0]?.slice(0, 1), ["devbox"]);
    assert.deepEqual(createCalls[0]?.[1], {
      repo: repos[0],
      slug: source.slug,
      branch: source.branch,
      baseRef: "origin/main",
    });
  });

  test("create synchronously registers a missing repo with URL, branch hint, and hooks", async () => {
    const harness = createHarness(
      makeState({ contexts: [contexts[0]], repos: [], clones: [], worktrees: [] }),
    );
    const cloneCalls: unknown[][] = [];
    harness.deps.repos.clone = async (remote, contextId, _onEvent, opts) => {
      cloneCalls.push([remote, contextId, opts]);
      const job = {
        id: remote.fullName,
        owner: remote.owner,
        name: remote.name,
        url: opts?.url ?? remote.sshUrl,
        contextId,
        defaultBranch: remote.defaultBranch,
        path: `/home/test/.swarm/repos/${remote.fullName}`,
        stagingPath: `/home/test/.swarm/repos/${remote.fullName}.staging`,
        logPath: "/home/test/.swarm/logs/clone.log",
        pid: 42,
        startedAt: "2026-09-03T00:00:00.000Z",
        status: "cloning" as const,
      };
      await harness.state.mutate((state) => {
        state.clones.push(job);
      });
      return job;
    };
    harness.deps.repos.reconcileClones = async () => {
      await harness.state.mutate((state) => {
        const job = state.clones[0];
        if (!job) return;
        state.repos.push({
          id: job.id,
          owner: job.owner,
          name: job.name,
          url: job.url,
          contextId: job.contextId,
          defaultBranch: job.defaultBranch,
          path: job.path,
          clonedAt: "2026-09-03T00:00:00.000Z",
          hooks: { prepare: [], postCreate: [] },
        });
        state.clones = [];
      });
      return [];
    };
    const hooks = { prepare: ["npm ci"], postCreate: ["npm test"] };
    const url = "ssh://git@example.test/bukhr/new-repo.git";

    await handleProtocolCommand(
      {
        kind: "create",
        repoId: "bukhr/new-repo",
        slug: "feature",
        branch: "feat/feature",
        baseRef: "origin/trunk",
        url,
        defaultBranch: "trunk",
        hooks,
        json: true,
      },
      harness.deps,
    );

    assert.equal(cloneCalls.length, 1);
    const cloneCall = cloneCalls[0];
    assert.ok(cloneCall);
    assert.deepEqual(cloneCall[2], { url });
    const remote = cloneCall[0];
    assert.ok(typeof remote === "object" && remote !== null && "defaultBranch" in remote);
    assert.equal(remote.defaultBranch, "trunk");
    assert.deepEqual(harness.state.state.repos[0]?.hooks, hooks);
    assert.deepEqual(harness.createdInputs[0], {
      repoId: "bukhr/new-repo",
      slug: "feature",
      branch: "feat/feature",
      baseRef: "origin/trunk",
    });
  });

  test("create resumes an active clone job instead of cloning the repo again", async () => {
    const clone: CloneJob = {
      id: "bukhr/new-repo",
      owner: "bukhr",
      name: "new-repo",
      url: "ssh://git@example.test/bukhr/new-repo.git",
      contextId: "buk",
      defaultBranch: "trunk",
      path: "/home/test/.swarm/repos/bukhr/new-repo",
      stagingPath: "/home/test/.swarm/repos/bukhr/new-repo.staging",
      logPath: "/home/test/.swarm/logs/clone.log",
      pid: 42,
      startedAt: "2026-09-03T00:00:00.000Z",
      status: "cloning",
    };
    const harness = createHarness(
      makeState({ contexts: [contexts[0]], repos: [], clones: [clone], worktrees: [] }),
    );
    let cloneCalls = 0;
    let reconciliations = 0;
    harness.deps.repos.clone = async () => {
      cloneCalls += 1;
      throw new Error("clone should not be called");
    };
    harness.deps.repos.reconcileClones = async () => {
      reconciliations += 1;
      if (reconciliations === 2) {
        await harness.state.mutate((state) => {
          state.repos.push({
            id: clone.id,
            owner: clone.owner,
            name: clone.name,
            url: clone.url,
            contextId: clone.contextId,
            defaultBranch: clone.defaultBranch,
            path: clone.path,
            clonedAt: "2026-09-03T00:00:00.000Z",
            hooks: { prepare: [], postCreate: [] },
          });
          state.clones = [];
        });
      }
      return harness.state.state.clones;
    };
    harness.deps.waitForClonePoll = async () => {
      assert.fail("completed reconciliation should not sleep");
    };
    const hooks = { prepare: ["npm ci"], postCreate: ["npm test"] };

    await handleProtocolCommand(
      {
        kind: "create",
        repoId: clone.id,
        slug: "feature",
        branch: "feat/feature",
        baseRef: "origin/trunk",
        hooks,
        json: true,
      },
      harness.deps,
    );

    assert.equal(cloneCalls, 0);
    assert.equal(reconciliations, 2);
    assert.deepEqual(harness.state.state.repos[0]?.hooks, hooks);
    assert.equal(harness.createdInputs[0]?.repoId, clone.id);
  });

  test("create surfaces the persisted failure from an interrupted clone", async () => {
    const clone: CloneJob = {
      id: "bukhr/new-repo",
      owner: "bukhr",
      name: "new-repo",
      url: "ssh://git@example.test/bukhr/new-repo.git",
      contextId: "buk",
      defaultBranch: "trunk",
      path: "/home/test/.swarm/repos/bukhr/new-repo",
      stagingPath: "/home/test/.swarm/repos/bukhr/new-repo.staging",
      logPath: "/home/test/.swarm/logs/clone.log",
      startedAt: "2026-09-03T00:00:00.000Z",
      status: "failed",
      error: "Clone stopped: authentication failed",
    };
    const harness = createHarness(
      makeState({ contexts: [contexts[0]], repos: [], clones: [clone], worktrees: [] }),
    );
    let cloneCalls = 0;
    harness.deps.repos.clone = async () => {
      cloneCalls += 1;
      throw new Error("clone should not be called");
    };

    await assert.rejects(
      handleProtocolCommand(
        {
          kind: "create",
          repoId: clone.id,
          slug: "feature",
          branch: "feat/feature",
          baseRef: "origin/trunk",
          hooks: { prepare: [], postCreate: [] },
          json: true,
        },
        harness.deps,
      ),
      (error: unknown) => {
        assert.ok(error instanceof SwarmError);
        assert.equal(error.code, "git");
        assert.equal(error.message, clone.error);
        return true;
      },
    );
    assert.equal(cloneCalls, 0);
  });

  test("create returns a validation error envelope when an unregistered repo has no URL", async () => {
    const { deps } = createHarness(makeState({ repos: [], worktrees: [] }));
    let failure: unknown;
    try {
      await handleProtocolCommand(
        {
          kind: "create",
          repoId: "bukhr/missing",
          slug: "feature",
          branch: "feature",
          baseRef: "origin/main",
          hooks: { prepare: [], postCreate: [] },
          json: true,
        },
        deps,
      );
    } catch (error) {
      failure = error;
    }

    assert.deepEqual(protocolErrorEnvelope(failure), {
      protocol: 1,
      error: {
        kind: "validation",
        message: "Repository bukhr/missing is not registered; --url is required",
      },
    });
  });

  test("delete and kill succeed when their tmux session is absent", async () => {
    const killHarness = createHarness(makeState({ worktrees: [worktrees[0]] }));
    assert.deepEqual(
      await handleProtocolCommand(
        { kind: "kill", worktreeId: "bukhr/payroll#main", json: true },
        killHarness.deps,
      ),
      { protocol: 1, ok: true },
    );

    const deleteHarness = createHarness(makeState({ worktrees: [worktrees[0]] }));
    assert.deepEqual(
      await handleProtocolCommand(
        {
          kind: "delete",
          worktreeIds: ["bukhr/payroll#main"],
          json: true,
        },
        deleteHarness.deps,
      ),
      {
        protocol: 1,
        ok: true,
        results: [{ worktreeId: "bukhr/payroll#main", ok: true }],
      },
    );
    assert.deepEqual(deleteHarness.deleted, ["bukhr/payroll#main"]);
    assert.equal(deleteHarness.state.state.worktrees.length, 0);
  });

  test("delete is unconditional, supports multiple ids, and reports failures per id", async () => {
    const selected = worktrees.slice(0, 2);
    const harness = createHarness(makeState({ worktrees: selected }));
    harness.deps.inspections.inspect = async () => {
      throw new Error("delete must not inspect worktrees");
    };
    const missing = "bukhr/payroll#missing";

    const response = await handleProtocolCommand(
      {
        kind: "delete",
        worktreeIds: [selected[0]?.id ?? "bukhr/payroll#main", missing, selected[1]?.id ?? missing],
        json: true,
      },
      harness.deps,
    );

    assert.deepEqual(response, {
      protocol: 1,
      ok: false,
      results: [
        { worktreeId: selected[0]?.id, ok: true },
        { worktreeId: missing, ok: false, reason: `Worktree not found: ${missing}` },
        { worktreeId: selected[1]?.id, ok: true },
      ],
    });
    assert.deepEqual(
      harness.deleted,
      selected.map(({ id }) => id),
    );
    assert.equal(harness.state.state.worktrees.length, 0);
  });

  test("prune selects only clean merged worktrees", async () => {
    const selected = worktrees.slice(0, 4);
    const pruneHarness = createHarness(makeState({ worktrees: selected }));
    pruneHarness.deps.inspections.inspect = async () => [
      inspectionFor(selected[0] as Worktree, {
        mergedIntoTarget: true,
        published: true,
        merged: true,
      }),
      inspectionFor(selected[1] as Worktree, {
        mergedIntoTarget: false,
        uniqueCommits: 3,
        merged: true,
        pr: {
          number: 12,
          state: "MERGED",
          url: "https://github.com/bukhr/payroll/pull/12",
          baseRefName: "main",
          headRefOid: "1".repeat(40),
        },
      }),
      inspectionFor(selected[2] as Worktree, {
        upstreamGone: true,
        mergedIntoTarget: true,
        uniqueCommits: 0,
        published: false,
        merged: false,
      }),
      inspectionFor(selected[3] as Worktree, {
        uniqueCommits: 5,
        published: true,
        merged: true,
        running: ["server"],
      }),
    ];
    const pruned = await handleProtocolCommand(
      { kind: "prune", dryRun: true, noFetch: false, killSessions: false, json: true },
      pruneHarness.deps,
    );
    assert.deepEqual(pruned, {
      protocol: 1,
      dryRun: true,
      deleted: [selected[0]?.id, selected[1]?.id],
      skipped: [
        {
          worktreeId: selected[2]?.id,
          reason: "worktree is not merged",
          merged: false,
          dirty: false,
          uniqueCommits: 0,
          running: [],
        },
        {
          worktreeId: selected[3]?.id,
          reason: "tmux session has running commands: server",
          merged: true,
          dirty: false,
          uniqueCommits: 5,
          running: ["server"],
        },
      ],
    });
    assert.deepEqual(pruneHarness.deleted, []);
  });

  test("prune --kill-sessions selects only safe detached sessions and hard-kills them", async () => {
    const source = worktrees[1];
    assert.ok(source);
    const eligible = { ...source, id: "bukhr/payroll#eligible", slug: "eligible" };
    const attached = { ...source, id: "bukhr/payroll#attached", slug: "attached" };
    const unknown = { ...source, id: "bukhr/payroll#unknown", slug: "unknown" };
    const dirty = { ...source, id: "bukhr/payroll#dirty", slug: "dirty" };
    const unmerged = { ...source, id: "bukhr/payroll#unmerged", slug: "unmerged" };
    const unknownCommits = {
      ...source,
      id: "bukhr/payroll#unknown-commits",
      slug: "unknown-commits",
    };
    const selected = [eligible, attached, unknown, dirty, unmerged, unknownCommits];
    const harness = createHarness(makeState({ worktrees: selected }));
    let inspectionCalls = 0;
    harness.deps.inspections.inspect = async () => {
      inspectionCalls += 1;
      return selected.map((worktree) => {
        const common = { session: "detached" as const, running: ["claude"] };
        if (worktree.id === attached.id) {
          return inspectionFor(worktree, { ...common, session: "attached" });
        }
        if (worktree.id === unknown.id) {
          return inspectionFor(worktree, { ...common, session: "unknown", running: [] });
        }
        if (worktree.id === dirty.id) return inspectionFor(worktree, { ...common, dirty: true });
        if (worktree.id === unmerged.id) {
          return inspectionFor(worktree, { ...common, merged: false, uniqueCommits: 2 });
        }
        if (worktree.id === unknownCommits.id) {
          return inspectionFor(worktree, { ...common, uniqueCommits: null });
        }
        return inspectionFor(worktree, common);
      });
    };

    const response = await handleProtocolCommand(
      {
        kind: "prune",
        dryRun: false,
        noFetch: true,
        killSessions: true,
        json: true,
      },
      harness.deps,
    );

    assert.equal("deleted" in response ? response.deleted[0] : undefined, eligible.id);
    assert.deepEqual(harness.deleted, [eligible.id]);
    assert.equal(inspectionCalls, 1);
    assert.deepEqual(
      "skipped" in response
        ? response.skipped.map(({ worktreeId, reason }) => [worktreeId, reason])
        : [],
      [
        [attached.id, "tmux session is attached"],
        [unknown.id, "tmux session state is unknown"],
        [dirty.id, "worktree has uncommitted changes"],
        [unmerged.id, "worktree is not merged"],
        [unknownCommits.id, "cannot determine unique commits"],
      ],
    );
  });

  test("status preserves worktree order and emits the status protocol shape", async () => {
    const selected = worktrees.slice(0, 2);
    const { deps } = createHarness(makeState({ worktrees: selected }));
    const response = await handleProtocolCommand({ kind: "status", json: true }, deps);

    assert.deepEqual(response, {
      protocol: 1,
      statuses: selected.map((worktree) => ({
        worktreeId: worktree.id,
        session: "none",
        windows: [],
        running: [],
      })),
    });
  });

  test("status ignores remote mirrors and returns local statuses successfully", async () => {
    const local = worktrees[0];
    const source = worktrees[1];
    assert.ok(local && source);
    const mirror = { ...source, host: "devbox" };
    const { deps } = createHarness(makeState({ worktrees: [local, mirror] }));

    const response = await handleProtocolCommand({ kind: "status", json: true }, deps);

    assert.deepEqual(response, {
      protocol: 1,
      statuses: [
        {
          worktreeId: local.id,
          session: "none",
          windows: [],
          running: [],
        },
      ],
    });
  });
});
