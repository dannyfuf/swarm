import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SwarmError } from "../core/errors.ts";
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

describe("createWorktreeService", () => {
  test("creates a new branch with ordered progress and treats hook failures as warnings", async () => {
    const repo = repos[1];
    assert.ok(repo);
    const destination = "/home/test/.swarm/worktrees/bukhr/platform/feat-new-api";
    const state = createMemoryState(
      makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
    );
    const files = createFakeFiles({ paths: [repo.path] });
    const git = createFakeGit({ remoteBranches: { [destination]: ["origin/main"] } });
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
      "Copying tree",
      "Creating branch",
      "Running hooks",
    ]);
    assert.equal(created.baseRef, "origin/main");
    assert.equal(created.path, destination);
    assert.equal(created.session, "platform/feat-new-api");
    assert.deepEqual(logs, ["Hook failed (7): npm install"]);
    assert.equal(logger.entries[0]?.level, "warn");
    assert.ok(git.calls.some((call) => call.method === "checkoutNewBranch"));
    assert.deepEqual(state.state.worktrees, [created]);
  });

  test("tracks an existing remote branch and persists that branch as the resolved base", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const destination = "/home/test/.swarm/worktrees/bukhr/payroll/feat-existing";
    const git = createFakeGit({
      remoteBranches: { [destination]: ["origin/feat/existing", "origin/main"] },
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
      "feat..bad",
      "-leading",
      "trailing/",
      "name.lock",
      "bad~name",
      "bad^name",
      "bad:name",
      "bad?name",
      "bad*name",
      "bad[name",
      "bad\\name",
    ];

    for (const branch of invalid) {
      await assert.rejects(
        service.create({ repoId: "bukhr/payroll", branch }),
        (error) => error instanceof SwarmError && error.code === "validation",
      );
    }
    assert.deepEqual(git.calls, []);
    assert.equal(state.saves.length, 0);
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
    const git = createFakeGit({ remoteBranches: { [destination]: [] } });
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
