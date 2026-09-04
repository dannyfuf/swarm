import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SwarmError } from "../core/errors.ts";
import type { ContextService, RepoService, WorktreeService } from "../core/services.ts";
import type { CloneJob, Worktree } from "../core/types.ts";
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
    home: "/home/test/.swarm",
  });
  const status = createStatusService({
    tmux,
    process,
    config,
    logger: createNullLogger(),
  });
  const deps: ProtocolDependencies = {
    state,
    contexts: contextService,
    repos: repoService,
    worktrees: worktreeService,
    sessions,
    status,
  };
  return { deps, state, tmux, createdInputs, postCreate, deleted };
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
    assert.equal(
      "worktree" in response ? response.worktree.id : "unexpected",
      "bukhr/payroll#remote-copy",
    );
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
        { kind: "delete", worktreeId: "bukhr/payroll#main", json: true },
        deleteHarness.deps,
      ),
      { protocol: 1, ok: true },
    );
    assert.deepEqual(deleteHarness.deleted, ["bukhr/payroll#main"]);
    assert.equal(deleteHarness.state.state.worktrees.length, 0);
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
