import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SwarmError } from "../core/errors.ts";
import type { GithubPort, TmuxSession } from "../core/ports.ts";
import type { WorktreeService } from "../core/services.ts";
import type { RemoteRepo } from "../core/types.ts";
import { createFakeFiles } from "../testing/fakeFiles.ts";
import { createFakeGit } from "../testing/fakeGit.ts";
import { createFakeGithub } from "../testing/fakeGithub.ts";
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

function createWorktreeStub(): WorktreeService & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    async list() {
      return [];
    },
    async remoteBranches() {
      return [];
    },
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
    };
    const service = createRepoService({
      state,
      config: createMemoryConfig(),
      github,
      git: createFakeGit(),
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

  test("clones a repository, streams events, detects its default branch, and persists it", async () => {
    const state = createMemoryState(
      makeState({ contexts: [contexts[0]], repos: [], worktrees: [], activeContextId: "buk" }),
    );
    const destination = "/home/test/.swarm/repos/bukhr/benefits";
    const git = createFakeGit();
    const files = createFakeFiles();
    git.defaultBranch = async (path) => {
      git.calls.push({ method: "defaultBranch", args: [path] });
      return "trunk";
    };
    const service = createRepoService({
      state,
      config: createMemoryConfig(),
      github: createFakeGithub(),
      git,
      files,
      worktreeService: createWorktreeStub(),
      clock: createFixedClock("2026-03-02T00:00:00.000Z"),
      logger: createNullLogger(),
    });
    const events: string[] = [];

    const cloned = await service.clone(remoteRepos[0], "buk", (event) => {
      events.push(
        event.type === "step" ? event.label : event.type === "log" ? event.line : event.type,
      );
    });

    assert.equal(cloned.defaultBranch, "trunk");
    assert.equal(cloned.path, destination);
    assert.equal(cloned.url, remoteRepos[0]?.sshUrl);
    const cloneCall = git.calls.find(({ method }) => method === "clone");
    assert.equal(cloneCall?.args[0], remoteRepos[0]?.sshUrl);
    assert.match(String(cloneCall?.args[1]), new RegExp(`^${destination}\\.staging-`));
    assert.ok(files.calls.some(({ method, args }) => method === "move" && args[1] === destination));
    assert.deepEqual(events, ["Cloning", "Cloning", "done"]);
    assert.deepEqual(state.state.repos, [cloned]);
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
      files: createFakeFiles(),
      worktreeService: createWorktreeStub(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    const cloned = await service.clone(remoteRepos[0], "buk");

    const httpsUrl = "https://github.com/bukhr/benefits.git";
    assert.equal(git.calls.find(({ method }) => method === "clone")?.args[0], httpsUrl);
    assert.equal(cloned.url, httpsUrl);
    assert.equal(state.state.repos[0]?.url, httpsUrl);
  });

  test("rejects clone conflicts without cleanup and removes partial clones after git failure", async () => {
    const conflictFiles = createFakeFiles();
    const conflictService = createRepoService({
      state: createMemoryState(makeState()),
      config: createMemoryConfig(),
      github: createFakeGithub(),
      git: createFakeGit(),
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
    git.defaultBranch = async () => {
      throw new Error("broken origin HEAD");
    };
    const files = createFakeFiles();
    const failureService = createRepoService({
      state: createMemoryState(makeState({ contexts: [contexts[0]], repos: [], worktrees: [] })),
      config: createMemoryConfig(),
      github: createFakeGithub(),
      git,
      files,
      worktreeService: createWorktreeStub(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });
    await assert.rejects(
      failureService.clone(remoteRepos[0], "buk"),
      (error) => error instanceof SwarmError && error.code === "git",
    );
    assert.equal(files.removed.length, 1);
    assert.match(files.removed[0] ?? "", new RegExp(`^${destination}\\.staging-`));
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

  test("assigns repos and cascades deletion through every worktree session", async () => {
    const payrollWorktrees = worktrees.filter((worktree) => worktree.repoId === repos[0]?.id);
    const state = createMemoryState(
      makeState({
        contexts,
        repos: [repos[0]],
        worktrees: payrollWorktrees,
      }),
    );
    const files = createFakeFiles({
      paths: [repos[0]?.path ?? "", ...payrollWorktrees.map((worktree) => worktree.path)],
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
    const config = createMemoryConfig(fixtureConfig);
    const logger = createNullLogger();
    const worktreeService = createWorktreeService({
      state,
      config,
      git: createFakeGit(),
      files,
      tmux,
      shell: createFakeShell(),
      clock,
      logger,
    });
    const service = createRepoService({
      state,
      config,
      github: createFakeGithub(),
      git: createFakeGit(),
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
  });
});
