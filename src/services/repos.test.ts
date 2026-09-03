import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { SwarmError } from "../core/errors.ts";
import { hotCopyPath, hotCopyPidPath, hotCopyStagingPath } from "../core/paths.ts";
import type { GithubPort, TmuxSession } from "../core/ports.ts";
import type { WorktreeService } from "../core/services.ts";
import type { RemoteRepo } from "../core/types.ts";
import { createFakeFiles } from "../testing/fakeFiles.ts";
import { createFakeGit } from "../testing/fakeGit.ts";
import { createFakeGithub } from "../testing/fakeGithub.ts";
import { createFakeProcess } from "../testing/fakeProcess.ts";
import { createFakeShell } from "../testing/fakeShell.ts";
import { createFakeTmux } from "../testing/fakeTmux.ts";
import { createFixedClock } from "../testing/fixedClock.ts";
import {
  contexts,
  config as fixtureConfig,
  makeState,
  remoteRepos,
  repos,
  worktrees,
} from "../testing/fixtures.ts";
import { createMemoryConfig } from "../testing/memoryConfig.ts";
import { createMemoryState } from "../testing/memoryState.ts";
import { createNullLogger } from "../testing/nullLogger.ts";
import { createRepoService } from "./repos.ts";
import { createWorktreeService } from "./worktrees.ts";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
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

function createWorktreeStub(): WorktreeService & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    async reconcileCreating() {},
    async coordinateRepoDeletion(_repoId, action) {
      await action();
    },
    async list() {
      return [];
    },
    async remoteBranches() {
      return [];
    },
    async prepareHotCopy() {},
    async refreshPreparedCopy() {},
    async awaitPendingRefresh() {},
    async runPostCreateHooks() {},
    async create() {
      throw new SwarmError("unsupported", "not used");
    },
    async delete(id) {
      deleted.push(id);
    },
    async touch() {},
  };
}

function remote(owner: string, name: string): RemoteRepo {
  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
    description: name,
    sshUrl: `git@github.com:${owner}/${name}.git`,
    isPrivate: true,
    updatedAt: "2026-03-01T00:00:00.000Z",
    defaultBranch: "main",
  };
}

describe("createRepoService", () => {
  test("searches owners in parallel, excludes cloned repos, and forwards refresh", async () => {
    const state = createMemoryState(
      makeState({
        contexts: [{ ...contexts[0], owners: ["bukhr", "tools"] }],
        repos: [repos[0]],
        worktrees: [],
        activeContextId: "buk",
      }),
    );
    const github = createFakeGithub({
      bukhr: [remote("bukhr", "payroll"), remote("bukhr", "benefits")],
      tools: [remote("tools", "payroll-kit")],
    });
    const service = createRepoService({
      state,
      config: createMemoryConfig(),
      github,
      git: createFakeGit(),
      process: createFakeProcess(),
      files: createFakeFiles(),
      worktreeService: createWorktreeStub(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    const results = await service.searchRemote("buk", "pay", { refresh: true });

    assert.deepEqual(
      results.map((item) => item.fullName),
      ["tools/payroll-kit"],
    );
    assert.equal(github.calls.length, 2);
    for (const call of github.calls) {
      const options = call.args[1] as { force?: boolean };
      assert.equal(options.force, true);
    }
  });

  test("keeps successful owner results but throws a github error when every owner fails", async () => {
    const state = createMemoryState(
      makeState({
        contexts: [{ ...contexts[0], owners: ["good", "bad"] }],
        repos: [],
        worktrees: [],
      }),
    );
    let failGood = false;
    const github: GithubPort = {
      async viewer() {
        return { login: "test" };
      },
      async listRepos(owner) {
        if (owner === "bad" || failGood) throw new Error(`${owner} failed`);
        return [remote("good", "one")];
      },
      async findPullRequest() {
        return undefined;
      },
      async readCachedPullRequests() {
        return undefined;
      },
      async listPullRequests() {
        return { prs: [], fetchedAt: "2026-01-01T00:00:00.000Z" };
      },
    };
    const service = createRepoService({
      state,
      config: createMemoryConfig(),
      github,
      git: createFakeGit(),
      process: createFakeProcess(),
      files: createFakeFiles(),
      worktreeService: createWorktreeStub(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    assert.deepEqual(await service.searchRemote("buk", ""), [remote("good", "one")]);
    failGood = true;
    await assert.rejects(
      service.searchRemote("buk", ""),
      (error) => error instanceof SwarmError && error.code === "github",
    );
  });

  test("persists a detached clone job and promotes an empty clone with its GitHub branch hint", async () => {
    const state = createMemoryState(
      makeState({ contexts: [contexts[0]], repos: [], worktrees: [], activeContextId: "buk" }),
    );
    const destination = "/home/test/.swarm/repos/bukhr/benefits";
    const git = createFakeGit();
    const process = createFakeProcess();
    const files = createFakeFiles();
    git.defaultBranch = async (path, hint) => {
      git.calls.push({ method: "defaultBranch", args: [path, hint] });
      return hint ?? "main";
    };
    const service = createRepoService({
      state,
      config: createMemoryConfig(),
      github: createFakeGithub(),
      git,
      process,
      files,
      worktreeService: createWorktreeStub(),
      clock: createFixedClock("2026-03-02T00:00:00.000Z"),
      logger: createNullLogger(),
    });
    const events: string[] = [];

    const job = await service.clone(remoteRepos[0], "buk", (event) => {
      events.push(
        event.type === "step" ? event.label : event.type === "log" ? event.line : event.type,
      );
    });

    assert.equal(job.path, destination);
    assert.equal(job.url, remoteRepos[0]?.sshUrl);
    assert.equal(job.pid, 4242);
    assert.equal(job.status, "cloning");
    assert.match(job.logPath, /\/logs\/clone-bukhr-benefits-.*\.log$/);
    const cloneCall = git.calls.find(({ method }) => method === "cloneDetached");
    assert.equal(cloneCall?.args[0], remoteRepos[0]?.sshUrl);
    assert.match(String(cloneCall?.args[1]), new RegExp(`^${destination}\\.staging-`));
    assert.equal(cloneCall?.args[2], job.logPath);
    assert.deepEqual(events, ["Starting background clone", "done"]);
    assert.deepEqual(state.state.clones, [job]);
    assert.equal(state.state.repos.length, 0);

    process.alive.add(job.pid ?? 0);
    files.paths.add(`${job.stagingPath}/.git`);
    await service.reconcileClones();
    assert.deepEqual(state.state.clones, [job]);

    process.alive.delete(job.pid ?? 0);
    await service.reconcileClones();

    assert.deepEqual(state.state.clones, []);
    assert.equal(state.state.repos[0]?.id, job.id);
    assert.equal(state.state.repos[0]?.defaultBranch, "main");
    assert.deepEqual(git.calls.find(({ method }) => method === "defaultBranch")?.args, [
      job.stagingPath,
      "main",
    ]);
    assert.ok(files.calls.some(({ method, args }) => method === "move" && args[1] === destination));
  });

  test("clones and persists the GitHub HTTPS URL when configured", async () => {
    const state = createMemoryState(
      makeState({ contexts: [contexts[0]], repos: [], worktrees: [], activeContextId: "buk" }),
    );
    const git = createFakeGit();
    const config = createMemoryConfig({
      ...fixtureConfig,
      github: { ...fixtureConfig.github, cloneProtocol: "https" },
    });
    const service = createRepoService({
      state,
      config,
      github: createFakeGithub(),
      git,
      process: createFakeProcess(),
      files: createFakeFiles(),
      worktreeService: createWorktreeStub(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    const cloned = await service.clone(remoteRepos[0], "buk");

    const httpsUrl = "https://github.com/bukhr/benefits.git";
    assert.equal(git.calls.find(({ method }) => method === "cloneDetached")?.args[0], httpsUrl);
    assert.equal(cloned.url, httpsUrl);
    assert.equal(state.state.clones[0]?.url, httpsUrl);
  });

  test("rejects clone conflicts and marks an exited partial clone as failed", async () => {
    const conflictFiles = createFakeFiles();
    const conflictService = createRepoService({
      state: createMemoryState(makeState()),
      config: createMemoryConfig(),
      github: createFakeGithub(),
      git: createFakeGit(),
      process: createFakeProcess(),
      files: conflictFiles,
      worktreeService: createWorktreeStub(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });
    await assert.rejects(
      conflictService.clone(remote("bukhr", "payroll"), "buk"),
      (error) => error instanceof SwarmError && error.code === "conflict",
    );
    assert.deepEqual(conflictFiles.removed, []);

    const destination = "/home/test/.swarm/repos/bukhr/benefits";
    const git = createFakeGit();
    const files = createFakeFiles();
    const failedState = createMemoryState(
      makeState({ contexts: [contexts[0]], repos: [], worktrees: [] }),
    );
    const failureService = createRepoService({
      state: failedState,
      config: createMemoryConfig(),
      github: createFakeGithub(),
      git,
      process: createFakeProcess(),
      files,
      worktreeService: createWorktreeStub(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });
    const job = await failureService.clone(remoteRepos[0], "buk");
    await failureService.reconcileClones();

    assert.equal(failedState.state.clones[0]?.status, "failed");
    assert.match(failedState.state.clones[0]?.error ?? "", /valid repository/);
    assert.equal(files.removed.length, 1);
    assert.equal(files.removed[0], job.stagingPath);
    assert.ok(!files.removed.includes(destination));
  });

  test("never removes an unregistered destination that already exists", async () => {
    const destination = "/home/test/.swarm/repos/bukhr/benefits";
    const files = createFakeFiles({ paths: [destination] });
    const git = createFakeGit();
    const service = createRepoService({
      state: createMemoryState(makeState({ contexts: [contexts[0]], repos: [], worktrees: [] })),
      config: createMemoryConfig(),
      github: createFakeGithub(),
      git,
      process: createFakeProcess(),
      files,
      worktreeService: createWorktreeStub(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    await assert.rejects(
      service.clone(remoteRepos[0], "buk"),
      (error) => error instanceof SwarmError && error.code === "conflict",
    );
    assert.deepEqual(files.removed, []);
    assert.equal(git.calls.length, 0);
  });

  test("refuses to delete a repo whose persisted path is outside its configured root", async () => {
    const registered = repos[0];
    assert.ok(registered);
    const corrupt = { ...registered, path: "/tmp/not-managed/payroll" };
    const files = createFakeFiles({ paths: [corrupt.path] });
    const service = createRepoService({
      state: createMemoryState(makeState({ repos: [corrupt], worktrees: [] })),
      config: createMemoryConfig(),
      github: createFakeGithub(),
      git: createFakeGit(),
      process: createFakeProcess(),
      files,
      worktreeService: createWorktreeStub(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    await assert.rejects(
      service.delete(corrupt.id),
      (error) => error instanceof SwarmError && error.code === "validation",
    );
    assert.equal(
      files.calls.some(({ method }) => method === "move"),
      false,
    );
    assert.deepEqual(files.removed, []);
  });

  test("assigns repos and deletes every discovered prepared slot after a pool shrink", async () => {
    const poolConfig = { ...fixtureConfig, hotPoolSize: 1 };
    const payrollWorktrees = worktrees.filter((worktree) => worktree.repoId === repos[0]?.id);
    const state = createMemoryState(
      makeState({
        contexts,
        repos: [repos[0]],
        worktrees: payrollWorktrees,
      }),
    );
    const preparedPaths = [0, 4].flatMap((slot) => [
      hotCopyPath(poolConfig.worktreesDir, "bukhr/payroll", slot),
      hotCopyStagingPath(poolConfig.worktreesDir, "bukhr/payroll", slot),
      hotCopyPidPath(poolConfig.worktreesDir, "bukhr/payroll", slot),
    ]);
    const files = createFakeFiles({
      paths: [
        repos[0]?.path ?? "",
        ...payrollWorktrees.map((worktree) => worktree.path),
        ...preparedPaths,
      ],
    });
    const sessions: TmuxSession[] = payrollWorktrees.map((worktree) => ({
      name: worktree.session,
      attached: false,
      windows: 1,
      createdAt: 0,
      lastActivityAt: 0,
    }));
    const tmux = createFakeTmux({ sessions });
    const clock = createFixedClock("2026-03-03T00:00:00.000Z");
    const config = createMemoryConfig(poolConfig);
    const logger = createNullLogger();
    const worktreeService = createWorktreeService({
      state,
      config,
      git: createFakeGit(),
      files,
      tmux,
      shell: createFakeShell(),
      process: createFakeProcess(),
      clock,
      logger,
    });
    const service = createRepoService({
      state,
      config,
      github: createFakeGithub(),
      git: createFakeGit(),
      process: createFakeProcess(),
      files,
      worktreeService,
      clock,
      logger,
    });

    const assigned = await service.assign("bukhr/payroll", "personal");
    assert.equal(assigned.contextId, "personal");
    await service.delete("bukhr/payroll");

    assert.deepEqual(
      tmux.calls.filter((call) => call.method === "killSession").map((call) => call.args[0]),
      payrollWorktrees.map((worktree) => worktree.session),
    );
    assert.deepEqual(state.state.repos, []);
    assert.deepEqual(state.state.worktrees, []);
    for (const path of preparedPaths) assert.ok(files.removed.includes(path));
  });

  test("deleting a repo waits for a detached preparation and leaves no prepared slot", async () => {
    const fixture = repos[0];
    assert.ok(fixture);
    const repo = { ...fixture, hooks: { prepare: ["prepare command"], postCreate: [] } };
    const state = createMemoryState(makeState({ contexts, repos: [repo], worktrees: [] }));
    const config = createMemoryConfig(fixtureConfig);
    const hot = hotCopyPath(fixtureConfig.worktreesDir, repo.id);
    const staging = hotCopyStagingPath(fixtureConfig.worktreesDir, repo.id);
    const files = createFakeFiles({ paths: [repo.path, join(repo.path, ".git")] });
    const workerStarted = deferred<void>();
    const shell = createFakeShell();
    files.cloneTreeDetached = async (_src, workerStaging, _dest, workerPidPath) => {
      await files.ensureDir(workerStaging);
      await files.writeTextAtomic(workerPidPath, "4242\n");
      workerStarted.resolve();
      return 4242;
    };
    const process = createFakeProcess([
      { pid: 4242, ppid: 1, command: `sh swarm-hot-copy ${staging}` },
    ]);
    const logger = createNullLogger();
    const worktreeService = createWorktreeService({
      state,
      config,
      git: createFakeGit({
        remoteBranches: { [repo.path]: ["origin/main"] },
        revisions: { [repo.path]: { HEAD: "a".repeat(40), "origin/main": "a".repeat(40) } },
      }),
      files,
      tmux: createFakeTmux(),
      shell,
      process,
      clock: createFixedClock(),
      logger,
    });
    const repoService = createRepoService({
      state,
      config,
      github: createFakeGithub(),
      git: createFakeGit(),
      process: createFakeProcess(),
      files,
      worktreeService,
      clock: createFixedClock(),
      logger,
    });

    const preparation = worktreeService.prepareHotCopy(repo.id);
    await workerStarted.promise;
    const deletion = repoService.delete(repo.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await files.move(staging, hot);
    await files.removeTree(hotCopyPidPath(fixtureConfig.worktreesDir, repo.id));
    process.alive.delete(4242);
    await Promise.allSettled([preparation]);
    await deletion;

    assert.equal(await files.exists(hot), false);
    assert.equal(await files.exists(staging), false);
    assert.deepEqual(state.state.repos, []);
  });
});
