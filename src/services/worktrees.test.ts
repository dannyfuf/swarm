import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SwarmError } from "../core/errors.ts";
import { hotCopyPath, hotCopyStagingPath } from "../core/paths.ts";
import type { TmuxSession } from "../core/ports.ts";
import { createFakeFiles } from "../testing/fakeFiles.ts";
import { createFakeGit } from "../testing/fakeGit.ts";
import { createFakeShell } from "../testing/fakeShell.ts";
import { createFakeTmux } from "../testing/fakeTmux.ts";
import { createFixedClock } from "../testing/fixedClock.ts";
import { contexts, makeState, repos, worktrees } from "../testing/fixtures.ts";
import { createMemoryConfig } from "../testing/memoryConfig.ts";
import { createMemoryState } from "../testing/memoryState.ts";
import { createNullLogger } from "../testing/nullLogger.ts";
import { createWorktreeService } from "./worktrees.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      assert.ok(resolvePromise);
      resolvePromise();
    },
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("createWorktreeService", () => {
  test("creates a new branch with ordered progress and treats hook failures as warnings", async () => {
    const repo = repos[1];
    assert.ok(repo);
    const destination = "/home/test/.swarm/worktrees/bukhr/platform/feat-new-api";
    const state = createMemoryState(
      makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
    );
    const files = createFakeFiles({ paths: [repo.path] });
    const git = createFakeGit({
      remoteBranches: {
        [repo.path]: ["origin/main"],
        [destination]: ["origin/main"],
      },
    });
    const shell = createFakeShell([
      {
        match: (cmd, args) => cmd === "sh" && args[1] === "npm install",
        result: { code: 7, stderr: "install failed" },
      },
    ]);
    const logger = createNullLogger();
    const service = createWorktreeService({
      state,
      config: createMemoryConfig(),
      git,
      files,
      tmux: createFakeTmux(),
      shell,
      clock: createFixedClock("2026-03-04T00:00:00.000Z"),
      logger,
    });
    const steps: string[] = [];
    const logs: string[] = [];

    const created = await service.create({ repoId: repo.id, branch: "feat/new-api" }, (event) => {
      if (event.type === "step") steps.push(event.label);
      if (event.type === "log") logs.push(event.line);
    });

    assert.deepEqual(steps, [
      "Fetching origin",
      "Updating base",
      "Copying repository",
      "Creating branch",
      "Running hooks",
    ]);
    assert.equal(created.baseRef, "origin/main");
    assert.equal(created.path, destination);
    assert.equal(created.session, "platform/feat-new-api");
    assert.deepEqual(logs, ["Hook failed (7): npm install"]);
    assert.equal(logger.entries[0]?.level, "warn");
    assert.ok(git.calls.some((call) => call.method === "checkoutNewBranch"));
    assert.deepEqual(files.calls.find(({ method }) => method === "cloneTree")?.args, [
      repo.path,
      destination,
    ]);
    assert.equal(
      files.calls.some(({ method }) => method === "move"),
      false,
    );
    assert.deepEqual(state.state.worktrees, [created]);
  });

  test("consumes a hot copy, refreshes it in place, then runs hooks and persists", async () => {
    const currentRepo = repos[1];
    assert.ok(currentRepo);
    const repo = { ...currentRepo, defaultBranch: "master" };
    const destination = "/home/test/.swarm/worktrees/bukhr/platform/feat-hot";
    const hot = hotCopyPath("/home/test/.swarm/worktrees", repo.id);
    const state = createMemoryState(
      makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
    );
    const files = createFakeFiles({ paths: [repo.path, hot] });
    const git = createFakeGit({
      defaultBranches: { [destination]: "main" },
      remoteBranches: { [destination]: ["origin/main"] },
    });
    const shell = createFakeShell([
      { match: (cmd, args) => cmd === "sh" && args[1] === "npm install", result: {} },
    ]);
    const service = createWorktreeService({
      state,
      config: createMemoryConfig(),
      git,
      files,
      tmux: createFakeTmux(),
      shell,
      clock: createFixedClock("2026-03-04T00:00:00.000Z"),
      logger: createNullLogger(),
    });
    const steps: string[] = [];

    const created = await service.create({ repoId: repo.id, branch: "feat/hot" }, (event) => {
      if (event.type === "step") steps.push(event.label);
    });

    assert.deepEqual(steps, [
      "Using prepared copy",
      "Fetching origin",
      "Updating base",
      "Creating branch",
      "Running hooks",
    ]);
    assert.ok(
      files.calls.some(
        ({ method, args }) => method === "move" && args[0] === hot && args[1] === destination,
      ),
    );
    assert.equal(
      files.calls.some(({ method }) => method === "cloneTree"),
      false,
    );
    const destinationFetch = git.calls.find(
      ({ method, args }) => method === "fetch" && args[0] === destination,
    );
    assert.deepEqual(destinationFetch?.args, [destination, { prune: true }]);
    assert.ok(
      git.calls.some(
        ({ method, args }) =>
          method === "resetToRemote" && args[0] === destination && args[1] === "main",
      ),
    );
    assert.equal(
      git.calls.some(({ method, args }) => method === "fetch" && args[0] === repo.path),
      false,
    );
    assert.equal(state.state.repos[0]?.defaultBranch, "main");
    assert.deepEqual(state.state.worktrees, [created]);
    assert.equal(shell.calls[0]?.opts?.cwd, destination);
  });

  test("prepareHotCopy is idempotent when the hot copy already exists", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const hot = hotCopyPath("/home/test/.swarm/worktrees", repo.id);
    const files = createFakeFiles({ paths: [repo.path, hot] });
    const git = createFakeGit();
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(),
      git,
      files,
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    await service.prepareHotCopy(repo.id);

    assert.deepEqual(git.calls, []);
    assert.equal(
      files.calls.some(({ method }) => method === "cloneTree"),
      false,
    );
    assert.equal(files.paths.has(hot), true);
  });

  test("prepareHotCopy removes stale staging, stages the copy, and atomically publishes it", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const hot = hotCopyPath("/home/test/.swarm/worktrees", repo.id);
    const staging = hotCopyStagingPath("/home/test/.swarm/worktrees", repo.id);
    const files = createFakeFiles({ paths: [repo.path, staging] });
    const git = createFakeGit({ remoteBranches: { [repo.path]: ["origin/main"] } });
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(),
      git,
      files,
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    await service.prepareHotCopy(repo.id);

    assert.ok(
      files.calls.some(({ method, args }) => method === "removeTree" && args[0] === staging),
    );
    assert.ok(
      files.calls.some(
        ({ method, args }) =>
          method === "cloneTree" && args[0] === repo.path && args[1] === staging,
      ),
    );
    assert.ok(
      files.calls.some(
        ({ method, args }) => method === "move" && args[0] === staging && args[1] === hot,
      ),
    );
    assert.equal(files.paths.has(hot), true);
    assert.equal(files.paths.has(staging), false);
  });

  test("prepareHotCopy cleans staging when copying fails", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const staging = hotCopyStagingPath("/home/test/.swarm/worktrees", repo.id);
    const files = createFakeFiles({ paths: [repo.path] });
    const cloneTree = files.cloneTree.bind(files);
    files.cloneTree = async (source, destination) => {
      await cloneTree(source, destination);
      throw new Error("copy failed");
    };
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(),
      git: createFakeGit({ remoteBranches: { [repo.path]: ["origin/main"] } }),
      files,
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    await assert.rejects(service.prepareHotCopy(repo.id), /Failed to prepare worktree copy/u);

    assert.equal(files.paths.has(staging), false);
    assert.ok(
      files.calls.some(({ method, args }) => method === "removeTree" && args[0] === staging),
    );
  });

  test("concurrent prepareHotCopy calls share one in-flight promise", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const gate = deferred();
    const files = createFakeFiles({ paths: [repo.path] });
    files.cloneTree = async (source, destination) => {
      files.calls.push({ method: "cloneTree", args: [source, destination] });
      await gate.promise;
      files.paths.add(destination);
    };
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(),
      git: createFakeGit({ remoteBranches: { [repo.path]: ["origin/main"] } }),
      files,
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    const first = service.prepareHotCopy(repo.id);
    const second = service.prepareHotCopy(repo.id);
    assert.equal(first, second);
    await flush();
    assert.equal(files.calls.filter(({ method }) => method === "cloneTree").length, 1);
    gate.resolve();
    await first;
  });

  test("create awaits an in-flight preparation and then consumes the completed hot copy", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const destination = "/home/test/.swarm/worktrees/bukhr/payroll/feat-wait";
    const hot = hotCopyPath("/home/test/.swarm/worktrees", repo.id);
    const gate = deferred();
    const files = createFakeFiles({ paths: [repo.path] });
    const cloneTree = files.cloneTree.bind(files);
    files.cloneTree = async (source, target) => {
      await gate.promise;
      await cloneTree(source, target);
    };
    const git = createFakeGit({
      remoteBranches: {
        [repo.path]: ["origin/main"],
        [destination]: ["origin/main"],
      },
    });
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(),
      git,
      files,
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    const preparation = service.prepareHotCopy(repo.id);
    await flush();
    const creation = service.create({ repoId: repo.id, branch: "feat/wait" });
    await flush();
    assert.equal(
      git.calls.some(({ method, args }) => method === "fetch" && args[0] === destination),
      false,
    );

    gate.resolve();
    await preparation;
    await creation;

    assert.equal(files.paths.has(hot), false);
    assert.ok(
      files.calls.some(
        ({ method, args }) => method === "move" && args[0] === hot && args[1] === destination,
      ),
    );
    assert.equal(
      files.calls.filter(({ method, args }) => method === "cloneTree" && args[0] === repo.path)
        .length,
      1,
    );
  });

  test("self-heals a stale default branch and persists the resolved branch", async () => {
    const currentRepo = repos[0];
    assert.ok(currentRepo);
    const repo = { ...currentRepo, defaultBranch: "master" };
    const destination = "/home/test/.swarm/worktrees/bukhr/payroll/feat-healed";
    const state = createMemoryState(
      makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
    );
    const git = createFakeGit({
      defaultBranches: { [repo.path]: "main" },
      remoteBranches: {
        [repo.path]: ["origin/main"],
        [destination]: ["origin/main"],
      },
    });
    const service = createWorktreeService({
      state,
      config: createMemoryConfig(),
      git,
      files: createFakeFiles({ paths: [repo.path] }),
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    const created = await service.create({ repoId: repo.id, branch: "feat/healed" });

    assert.equal(state.state.repos[0]?.defaultBranch, "main");
    assert.equal(created.baseRef, "origin/main");
    assert.deepEqual(git.calls.find(({ method }) => method === "defaultBranch")?.args, [
      repo.path,
      "master",
    ]);
    assert.deepEqual(git.calls.find(({ method }) => method === "resetToRemote")?.args, [
      repo.path,
      "main",
    ]);
  });

  test("reports a clear git error when the remote is still empty", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const git = createFakeGit({ remoteBranches: { [repo.path]: [] } });
    const files = createFakeFiles({ paths: [repo.path] });
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(),
      git,
      files,
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    await assert.rejects(
      service.create({ repoId: repo.id, branch: "feat/first" }),
      (error) =>
        error instanceof SwarmError &&
        error.code === "git" &&
        error.message ===
          "Remote has no 'main' branch yet; push an initial commit to bukhr/payroll first",
    );
    assert.equal(
      git.calls.some(({ method }) => method === "resetToRemote"),
      false,
    );
    assert.equal(
      files.calls.some(({ method }) => method === "cloneTree"),
      false,
    );
  });

  test("tracks an existing remote branch and persists that branch as the resolved base", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const destination = "/home/test/.swarm/worktrees/bukhr/payroll/feat-existing";
    const git = createFakeGit({
      remoteBranches: {
        [repo.path]: ["origin/main"],
        [destination]: ["origin/feat/existing", "origin/main"],
      },
    });
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(),
      git,
      files: createFakeFiles({ paths: [repo.path] }),
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    const created = await service.create({ repoId: repo.id, branch: "feat/existing" });

    assert.equal(created.baseRef, "origin/feat/existing");
    assert.deepEqual(git.calls.find((call) => call.method === "checkoutTracking")?.args, [
      destination,
      "feat/existing",
    ]);
  });

  test("fetches a fork PR head before checkout and persists its pull ref", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const destination = "/home/test/.swarm/worktrees/bukhr/payroll/pr-77";
    const state = createMemoryState(
      makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
    );
    const git = createFakeGit({ remoteBranches: { [repo.path]: ["origin/main"] } });
    const service = createWorktreeService({
      state,
      config: createMemoryConfig(),
      git,
      files: createFakeFiles({ paths: [repo.path] }),
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });
    const steps: string[] = [];

    const created = await service.create(
      { repoId: repo.id, branch: "pr/77", source: { kind: "pull", number: 77 } },
      (event) => {
        if (event.type === "step") steps.push(event.label);
      },
    );

    assert.equal(created.path, destination);
    assert.equal(created.baseRef, "pull/77/head");
    assert.ok(steps.includes("Fetching PR head"));
    assert.equal(steps.includes("Creating branch"), false);
    const branchCalls = git.calls.filter(({ method }) =>
      ["fetchPullHead", "checkoutTracking"].includes(method),
    );
    assert.deepEqual(branchCalls, [
      { method: "fetchPullHead", args: [destination, 77, "pr/77"] },
      { method: "checkoutTracking", args: [destination, "pr/77"] },
    ]);
    assert.equal(state.state.worktrees[0]?.baseRef, "pull/77/head");
  });

  test("rejects invalid branch forms before any I/O", async () => {
    const state = createMemoryState(makeState());
    const git = createFakeGit();
    const service = createWorktreeService({
      state,
      config: createMemoryConfig(),
      git,
      files: createFakeFiles(),
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });
    const invalid = [
      "",
      "feat with-space",
      "feat\u0001control",
      "feat\u007fcontrol",
      "feat..bad",
      "-leading",
      "/leading",
      "trailing/",
      "trailing.",
      "name.lock",
      "feat/name.lock/next",
      ".hidden",
      "feat/.hidden",
      "foo//bar",
      "foo/@{bar",
      "@",
      "bad~name",
      "bad^name",
      "bad:name",
      "bad?name",
      "bad*name",
      "bad[name",
      "bad\\name",
      ".hot",
      ".hot.staging",
    ];

    for (const branch of invalid) {
      await assert.rejects(
        service.create({ repoId: "bukhr/payroll", branch }),
        (error) => error instanceof SwarmError && error.code === "validation",
      );
    }
    assert.deepEqual(git.calls, []);
    assert.equal(state.saves.length, 0);

    await assert.rejects(
      service.create({
        repoId: "bukhr/payroll",
        branch: "pr/1",
        source: { kind: "pull", number: 0 },
      }),
      (error) => error instanceof SwarmError && error.code === "validation",
    );
    assert.deepEqual(git.calls, []);
  });

  test("detects id and path conflicts", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const existingService = createWorktreeService({
      state: createMemoryState(makeState()),
      config: createMemoryConfig(),
      git: createFakeGit(),
      files: createFakeFiles(),
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });
    await assert.rejects(
      existingService.create({ repoId: repo.id, branch: "main" }),
      (error) => error instanceof SwarmError && error.code === "conflict",
    );

    const destination = "/home/test/.swarm/worktrees/bukhr/payroll/new";
    const pathService = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(),
      git: createFakeGit(),
      files: createFakeFiles({ paths: [destination] }),
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });
    await assert.rejects(
      pathService.create({ repoId: repo.id, branch: "new" }),
      (error) => error instanceof SwarmError && error.code === "conflict",
    );
  });

  test("rejects a tmux session name collision across repos", async () => {
    const registered = repos[1];
    const existing = worktrees[0];
    assert.ok(registered && existing);
    const repo = { ...registered, name: "payroll" };
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [existing] }),
      ),
      config: createMemoryConfig(),
      git: createFakeGit(),
      files: createFakeFiles({ paths: [repo.path] }),
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    await assert.rejects(
      service.create({ repoId: repo.id, branch: "main" }),
      (error) => error instanceof SwarmError && error.code === "conflict",
    );
  });

  test("refuses to delete a worktree whose persisted path is outside its configured root", async () => {
    const repo = repos[0];
    const registered = worktrees[0];
    assert.ok(repo && registered);
    const corrupt = { ...registered, path: "/tmp/not-managed/main" };
    const files = createFakeFiles({ paths: [corrupt.path] });
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [corrupt] }),
      ),
      config: createMemoryConfig(),
      git: createFakeGit(),
      files,
      tmux: createFakeTmux(),
      shell: createFakeShell(),
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
  });

  test("removes a partial copy when branch checkout fails", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const destination = "/home/test/.swarm/worktrees/bukhr/payroll/feat-broken";
    const files = createFakeFiles({ paths: [repo.path] });
    const git = createFakeGit({
      remoteBranches: { [repo.path]: ["origin/main"], [destination]: [] },
    });
    git.checkoutNewBranch = async () => {
      throw new Error("checkout failed");
    };
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(),
      git,
      files,
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    await assert.rejects(
      service.create({ repoId: repo.id, branch: "feat/broken" }),
      (error) => error instanceof SwarmError && error.code === "git",
    );
    assert.deepEqual(files.removed, [destination]);
  });

  test("lists and sorts remote branches, touches, and deletes a worktree with its session", async () => {
    const target = worktrees[0];
    const repo = repos[0];
    assert.ok(target);
    assert.ok(repo);
    const state = createMemoryState(
      makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [target] }),
    );
    const git = createFakeGit({
      remoteBranches: {
        [repo.path]: ["origin/zeta", "origin/HEAD", "origin/alpha"],
      },
    });
    const files = createFakeFiles({ paths: [target.path] });
    const session: TmuxSession = {
      name: target.session,
      attached: false,
      windows: 1,
      createdAt: 0,
      lastActivityAt: 0,
    };
    const tmux = createFakeTmux({ sessions: [session] });
    const clock = createFixedClock("2026-03-05T00:00:00.000Z");
    const service = createWorktreeService({
      state,
      config: createMemoryConfig(),
      git,
      files,
      tmux,
      shell: createFakeShell(),
      clock,
      logger: createNullLogger(),
    });

    assert.deepEqual(await service.remoteBranches(repo.id), ["origin/alpha", "origin/zeta"]);
    assert.deepEqual(await service.list(repo.id), [target]);
    await service.touch(target.id);
    assert.equal(state.state.worktrees[0]?.lastOpenedAt, "2026-03-05T00:00:00.000Z");
    await service.delete(target.id);

    assert.ok(tmux.calls.some((call) => call.method === "killSession"));
    assert.deepEqual(state.state.worktrees, []);
    assert.deepEqual(files.removed, ["/home/test/.swarm/trash/1772668800000-main"]);
  });
});
