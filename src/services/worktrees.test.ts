import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { SwarmError } from "../core/errors.ts";
import { hotCopyPath, hotCopyPidPath, hotCopyStagingPath } from "../core/paths.ts";
import type { TmuxSession } from "../core/ports.ts";
import type { RemoteHostService } from "../core/services.ts";
import { defaultConfig } from "../core/types.ts";
import { createFakeFiles } from "../testing/fakeFiles.ts";
import { createFakeGit } from "../testing/fakeGit.ts";
import { createFakeProcess } from "../testing/fakeProcess.ts";
import { createFakeShell } from "../testing/fakeShell.ts";
import { createFakeTmux } from "../testing/fakeTmux.ts";
import { createFixedClock } from "../testing/fixedClock.ts";
import { contexts, makeState, repos, worktrees } from "../testing/fixtures.ts";
import { createMemoryConfig } from "../testing/memoryConfig.ts";
import { createMemoryState } from "../testing/memoryState.ts";
import { createNullLogger } from "../testing/nullLogger.ts";
import { mutateState } from "./stateMutation.ts";
import { createWorktreeService } from "./worktrees.ts";

const MAIN_SHA = "a".repeat(40);
const EMPTY_PREPARE_FINGERPRINT = createHash("sha256").update("[]").digest("hex");

function isAttemptPath(path: unknown, destination: string): boolean {
  return typeof path === "string" && path.startsWith(`${destination}.creating-`);
}

function markerPath(repoPath: string): string {
  return join(repoPath, ".git", "swarm-hot.json");
}

function creatingMarkerPath(repoPath: string): string {
  return join(repoPath, ".git", "swarm-creating.json");
}

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
  test("creates and registers a new branch before post-create hook warnings", async () => {
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
      process: createFakeProcess(),
      clock: createFixedClock("2026-03-04T00:00:00.000Z"),
      logger,
    });
    const steps: string[] = [];
    const logs: string[] = [];

    const created = await service.create({ repoId: repo.id, branch: "feat/new-api" }, (event) => {
      if (event.type === "step") steps.push(event.label);
      if (event.type === "log") logs.push(event.line);
    });
    assert.deepEqual(state.state.worktrees, [created]);
    await service.runPostCreateHooks(created.id, (event) => {
      if (event.type === "log") logs.push(event.line);
    });

    assert.deepEqual(steps, [
      "Checking prerequisites",
      "Claiming prepared copy",
      "Reading freshness marker",
      "Listing remote branches",
      "Resolving default branch",
      "Fetching origin",
      "Relisting remote branches",
      "Checking repository state",
      "Updating base",
      "Creating branch",
      "Registering worktree",
    ]);
    assert.equal(created.baseRef, "origin/main");
    assert.equal(created.path, destination);
    assert.equal(created.session, "platform/feat-new-api");
    assert.ok(logs.some((line) => /^Fetching origin (?:\d+ms|\d+\.\d+s)$/u.test(line)));
    assert.ok(
      logger.entries.some(
        ({ level, message }) => level === "info" && message.startsWith("Fetching origin "),
      ),
    );
    assert.ok(git.calls.some((call) => call.method === "checkoutNewBranch"));
    const cloneArgs = files.calls.find(({ method }) => method === "cloneTree")?.args;
    assert.equal(cloneArgs?.[0], repo.path);
    assert.ok(isAttemptPath(cloneArgs?.[1], destination));
    assert.ok(
      files.calls.some(
        ({ method, args }) =>
          method === "move" && isAttemptPath(args[0], destination) && args[1] === destination,
      ),
    );
  });

  test("consumes a hot copy, refreshes it in place, and registers before hooks", async () => {
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
      process: createFakeProcess(),
      clock: createFixedClock("2026-03-04T00:00:00.000Z"),
      logger: createNullLogger(),
    });
    const steps: string[] = [];

    const created = await service.create({ repoId: repo.id, branch: "feat/hot" }, (event) => {
      if (event.type === "step") steps.push(event.label);
    });
    assert.deepEqual(state.state.worktrees, [created]);
    await service.runPostCreateHooks(created.id);

    assert.deepEqual(steps, [
      "Checking prerequisites",
      "Claiming prepared copy",
      "Reading freshness marker",
      "Listing remote branches",
      "Resolving default branch",
      "Fetching origin",
      "Relisting remote branches",
      "Checking repository state",
      "Updating base",
      "Creating branch",
      "Registering worktree",
    ]);
    assert.ok(
      files.calls.some(
        ({ method, args }) =>
          method === "move" && args[0] === hot && isAttemptPath(args[1], destination),
      ),
    );
    assert.equal(
      files.calls.some(({ method }) => method === "cloneTree"),
      false,
    );
    const destinationFetch = git.calls.find(
      ({ method, args }) => method === "fetchRefs" && isAttemptPath(args[0], destination),
    );
    assert.deepEqual(destinationFetch?.args.slice(1), [
      "origin",
      [
        "+refs/heads/main:refs/remotes/origin/main",
        "+refs/heads/feat/hot:refs/remotes/origin/feat/hot",
      ],
      undefined,
    ]);
    assert.ok(
      git.calls.some(
        ({ method, args }) =>
          method === "resetToRemote" && isAttemptPath(args[0], destination) && args[1] === "main",
      ),
    );
    assert.equal(
      git.calls.some(({ method, args }) => method === "fetch" && args[0] === repo.path),
      false,
    );
    assert.equal(state.state.repos[0]?.defaultBranch, "main");
    assert.deepEqual(state.state.worktrees, [created]);
    assert.equal(shell.detachedLoggedCalls[0]?.opts?.cwd, destination);
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
      process: createFakeProcess(),
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

  test("prepareHotCopy removes stale staging and launches an atomic detached copy", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const hot = hotCopyPath("/home/test/.swarm/worktrees", repo.id);
    const staging = hotCopyStagingPath("/home/test/.swarm/worktrees", repo.id);
    const pidPath = hotCopyPidPath("/home/test/.swarm/worktrees", repo.id);
    const files = createFakeFiles({ paths: [repo.path, staging] });
    const git = createFakeGit({ remoteBranches: { [repo.path]: ["origin/main"] } });
    const logger = createNullLogger();
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(),
      git,
      files,
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      process: createFakeProcess(),
      clock: createFixedClock(),
      logger,
    });
    const steps: string[] = [];
    const logs: string[] = [];

    await service.prepareHotCopy(repo.id, (event) => {
      if (event.type === "step") steps.push(event.label);
      if (event.type === "log") logs.push(event.line);
    });

    assert.ok(
      files.calls.some(({ method, args }) => method === "removeTree" && args[0] === staging),
    );
    assert.ok(
      files.calls.some(
        ({ method, args }) =>
          method === "cloneTreeDetached" &&
          args[0] === repo.path &&
          args[1] === staging &&
          args[2] === hot &&
          args[3] === pidPath &&
          typeof args[4] === "string" &&
          args[4].endsWith("/logs/hot-copy-bukhr-payroll.log"),
      ),
    );
    assert.equal(
      files.calls.some(({ method }) => method === "move"),
      false,
    );
    assert.equal(files.paths.has(hot), true);
    assert.equal(files.paths.has(staging), false);
    assert.deepEqual(JSON.parse(files.texts.get(resolve(markerPath(hot))) ?? ""), {
      fetchedAt: "2026-01-01T00:00:00.000Z",
      defaultBranch: "main",
      sha: "2".repeat(40),
      prepareFingerprint: EMPTY_PREPARE_FINGERPRINT,
    });
    assert.ok(
      steps.every((step) => logs.some((line) => line.startsWith(`${step} `))),
      "every preparation step has an operation timing line",
    );
    assert.ok(
      logs.every((line) =>
        logger.entries.some(({ level, message }) => level === "info" && message === line),
      ),
      "preparation timings are also written through the logger",
    );
  });

  test("prepare hooks and their fingerprint are handed to the detached publisher", async () => {
    const fixture = repos[0];
    assert.ok(fixture);
    const repo = { ...fixture, hooks: { prepare: ["npm ci"], postCreate: [] } };
    const hot = hotCopyPath("/home/test/.swarm/worktrees", repo.id);
    const staging = hotCopyStagingPath("/home/test/.swarm/worktrees", repo.id);
    const files = createFakeFiles({ paths: [repo.path] });
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

    await service.prepareHotCopy(repo.id);

    const detached = files.calls.find(({ method }) => method === "cloneTreeDetached");
    assert.equal(detached?.args[1], staging);
    assert.equal(detached?.args[2], hot);
    const options = detached?.args[5] as
      | { markerText: string; prepareCommands: string[] }
      | undefined;
    assert.deepEqual(options?.prepareCommands, ["npm ci"]);
    assert.equal(
      JSON.parse(options?.markerText ?? "{}").prepareFingerprint,
      createHash("sha256")
        .update(JSON.stringify(["npm ci"]))
        .digest("hex"),
    );
    assert.equal(files.paths.has(hot), true);
  });

  test("replenishment fills only the lowest empty pool slot", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const loadedConfig = { ...defaultConfig("/home/test/.swarm"), hotPoolSize: 3 };
    const hot0 = hotCopyPath(loadedConfig.worktreesDir, repo.id, 0);
    const hot1 = hotCopyPath(loadedConfig.worktreesDir, repo.id, 1);
    const hot2 = hotCopyPath(loadedConfig.worktreesDir, repo.id, 2);
    const staging1 = hotCopyStagingPath(loadedConfig.worktreesDir, repo.id, 1);
    const files = createFakeFiles({ paths: [repo.path, hot0, staging1, hot2] });
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(loadedConfig),
      git: createFakeGit({ remoteBranches: { [repo.path]: ["origin/main"] } }),
      files,
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    await service.prepareHotCopy(repo.id);

    assert.deepEqual(
      files.calls.filter(({ method }) => method === "cloneTreeDetached").map(({ args }) => args[1]),
      [staging1],
    );
    assert.ok(
      files.calls.some(
        ({ method, args }) =>
          method === "cloneTreeDetached" && args[1] === staging1 && args[2] === hot1,
      ),
    );
    assert.equal(files.paths.has(hot0), true);
    assert.equal(files.paths.has(hot2), true);
  });

  test("creation consumes the lowest available pool slot", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const loadedConfig = { ...defaultConfig("/home/test/.swarm"), hotPoolSize: 3 };
    const hot1 = hotCopyPath(loadedConfig.worktreesDir, repo.id, 1);
    const hot2 = hotCopyPath(loadedConfig.worktreesDir, repo.id, 2);
    const destination = `${loadedConfig.worktreesDir}/${repo.id}/feat-pool-order`;
    const files = createFakeFiles({ paths: [repo.path, hot1, hot2] });
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(loadedConfig),
      git: createFakeGit({ remoteBranches: { [destination]: ["origin/main"] } }),
      files,
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });
    const events: string[] = [];

    await service.create({ repoId: repo.id, branch: "feat/pool-order" }, (event) => {
      events.push(event.type);
    });

    assert.ok(
      files.calls.some(
        ({ method, args }) =>
          method === "move" && args[0] === hot1 && isAttemptPath(args[1], destination),
      ),
    );
    assert.equal(files.paths.has(hot2), true);
    assert.ok(events.indexOf("prepared-copy-claimed") < events.lastIndexOf("step"));
  });

  test("hotPoolSize zero disables preparation and fallback runs prepare hooks", async () => {
    const fixture = repos[0];
    assert.ok(fixture);
    const repo = { ...fixture, hooks: { prepare: ["npm ci"], postCreate: [] } };
    const loadedConfig = { ...defaultConfig("/home/test/.swarm"), hotPoolSize: 0 };
    const destination = `${loadedConfig.worktreesDir}/${repo.id}/feat-no-pool`;
    const files = createFakeFiles({ paths: [repo.path] });
    const shell = createFakeShell([{ match: (_cmd, args) => args[1] === "npm ci", result: {} }]);
    const git = createFakeGit({ remoteBranches: { [destination]: ["origin/main"] } });
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(loadedConfig),
      git,
      files,
      tmux: createFakeTmux(),
      shell,
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    await service.prepareHotCopy(repo.id);
    assert.equal(
      files.calls.some(({ method }) => method === "cloneTree"),
      false,
    );
    assert.equal(git.calls.length, 0);

    await service.create({ repoId: repo.id, branch: "feat/no-pool" });
    assert.ok(isAttemptPath(shell.calls[0]?.opts?.cwd, destination));
    assert.ok(
      files.calls.some(
        ({ method, args }) =>
          method === "cloneTree" && args[0] === repo.path && isAttemptPath(args[1], destination),
      ),
    );
  });

  test("prepareHotCopy cleans staging when copying fails", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const staging = hotCopyStagingPath("/home/test/.swarm/worktrees", repo.id);
    const pidPath = hotCopyPidPath("/home/test/.swarm/worktrees", repo.id);
    const files = createFakeFiles({ paths: [repo.path] });
    files.cloneTreeDetached = async (source, destination, _hot, jobPidPath, logPath) => {
      files.calls.push({
        method: "cloneTreeDetached",
        args: [source, destination, _hot, jobPidPath, logPath],
      });
      files.paths.add(destination);
      files.paths.add(jobPidPath);
      return 4242;
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
      process: createFakeProcess(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    await assert.rejects(service.prepareHotCopy(repo.id), /exited before publishing/u);

    assert.equal(files.paths.has(staging), false);
    assert.equal(files.paths.has(pidPath), false);
    assert.ok(
      files.calls.some(({ method, args }) => method === "removeTree" && args[0] === staging),
    );
  });

  test("concurrent prepareHotCopy calls share one in-flight promise", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const hot = hotCopyPath("/home/test/.swarm/worktrees", repo.id);
    const staging = hotCopyStagingPath("/home/test/.swarm/worktrees", repo.id);
    const files = createFakeFiles({ paths: [repo.path] });
    files.cloneTreeDetached = async (source, destination, target, pidPath, logPath) => {
      files.calls.push({
        method: "cloneTreeDetached",
        args: [source, destination, target, pidPath, logPath],
      });
      files.paths.add(destination);
      return 4242;
    };
    const process = createFakeProcess([
      { pid: 4242, ppid: 1, command: `sh -c hot-copy ${staging}` },
    ]);
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(),
      git: createFakeGit({ remoteBranches: { [repo.path]: ["origin/main"] } }),
      files,
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      process,
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    const first = service.prepareHotCopy(repo.id);
    const second = service.prepareHotCopy(repo.id);
    assert.equal(first, second);
    await flush();
    assert.equal(files.calls.filter(({ method }) => method === "cloneTreeDetached").length, 1);
    files.paths.delete(staging);
    files.paths.add(hot);
    process.alive.delete(4242);
    await first;
  });

  test("create waits for an in-flight preparation, then consumes hot without a second copy", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const destination = "/home/test/.swarm/worktrees/bukhr/payroll/feat-wait";
    const hot = hotCopyPath("/home/test/.swarm/worktrees", repo.id);
    const staging = hotCopyStagingPath("/home/test/.swarm/worktrees", repo.id);
    const files = createFakeFiles({ paths: [repo.path] });
    files.cloneTreeDetached = async (source, target, destinationPath, pidPath, logPath) => {
      files.calls.push({
        method: "cloneTreeDetached",
        args: [source, target, destinationPath, pidPath, logPath],
      });
      files.paths.add(target);
      return 4242;
    };
    const process = createFakeProcess([
      { pid: 4242, ppid: 1, command: `sh -c hot-copy ${staging}` },
    ]);
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
      process,
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    const preparation = service.prepareHotCopy(repo.id);
    await flush();
    const steps: string[] = [];
    const creation = service.create({ repoId: repo.id, branch: "feat/wait" }, (event) => {
      if (event.type === "step") steps.push(event.label);
    });
    await flush();

    assert.equal(files.paths.has(staging), true);
    assert.equal(
      files.calls.some(({ method }) => method === "cloneTree"),
      false,
    );
    assert.ok(steps.indexOf("Waiting for prepared copy") > steps.indexOf("Checking prerequisites"));

    files.paths.delete(staging);
    files.paths.add(hot);
    process.alive.delete(4242);
    await preparation;
    const created = await creation;

    assert.equal(created.path, destination);
    assert.ok(steps.indexOf("Claiming prepared copy") > steps.indexOf("Waiting for prepared copy"));
    assert.equal(files.calls.filter(({ method }) => method === "cloneTreeDetached").length, 1);
    assert.equal(files.calls.filter(({ method }) => method === "cloneTree").length, 0);
    assert.ok(
      files.calls.some(
        ({ method, args }) =>
          method === "move" && args[0] === hot && isAttemptPath(args[1], destination),
      ),
    );
  });

  test("create waits for a failed preparation, then falls back to the slow copy", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const destination = "/home/test/.swarm/worktrees/bukhr/payroll/feat-fallback";
    const staging = hotCopyStagingPath("/home/test/.swarm/worktrees", repo.id);
    const files = createFakeFiles({ paths: [repo.path] });
    files.cloneTreeDetached = async (source, target, hot, pidPath, logPath) => {
      files.calls.push({
        method: "cloneTreeDetached",
        args: [source, target, hot, pidPath, logPath],
      });
      files.paths.add(target);
      files.paths.add(pidPath);
      return 4242;
    };
    const process = createFakeProcess([
      { pid: 4242, ppid: 1, command: `sh -c hot-copy ${staging}` },
    ]);
    const logger = createNullLogger();
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(),
      git: createFakeGit({
        remoteBranches: {
          [repo.path]: ["origin/main"],
          [destination]: ["origin/main"],
        },
      }),
      files,
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      process,
      clock: createFixedClock(),
      logger,
    });

    const preparation = service.prepareHotCopy(repo.id);
    await flush();
    const steps: string[] = [];
    const creation = service.create({ repoId: repo.id, branch: "feat/fallback" }, (event) => {
      if (event.type === "step") steps.push(event.label);
    });
    await flush();
    process.alive.delete(4242);

    await assert.rejects(preparation, /exited before publishing/u);
    const created = await creation;

    assert.equal(created.path, destination);
    assert.ok(steps.indexOf("Waiting for prepared copy") > steps.indexOf("Checking prerequisites"));
    assert.ok(steps.indexOf("Fetching origin") > steps.indexOf("Waiting for prepared copy"));
    assert.equal(files.calls.filter(({ method }) => method === "cloneTreeDetached").length, 1);
    assert.equal(files.calls.filter(({ method }) => method === "cloneTree").length, 1);
    assert.ok(
      logger.entries.some(
        ({ level, message }) =>
          level === "warn" && message === `Prepared copy failed; falling back for: ${repo.id}`,
      ),
    );
  });

  test("a fresh valid marker skips fetch and a matching clean tree skips reset", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const destination = "/home/test/.swarm/worktrees/bukhr/payroll/feat-fresh";
    const hot = hotCopyPath("/home/test/.swarm/worktrees", repo.id);
    const files = createFakeFiles({
      paths: [repo.path, hot],
      texts: {
        [markerPath(hot)]: JSON.stringify({
          fetchedAt: "2026-03-04T00:00:00.000Z",
          defaultBranch: "main",
          sha: MAIN_SHA,
          prepareFingerprint: EMPTY_PREPARE_FINGERPRINT,
        }),
      },
    });
    const git = createFakeGit({
      remoteBranches: { [destination]: ["origin/main"] },
      revisions: { [destination]: { HEAD: MAIN_SHA, "origin/main": MAIN_SHA } },
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
      clock: createFixedClock("2026-03-04T00:00:30.000Z"),
      logger: createNullLogger(),
    });

    await service.create({
      repoId: repo.id,
      branch: "feat/fresh",
      source: { kind: "pull", number: 1 },
    });

    assert.equal(
      git.calls.some(
        ({ method, args }) =>
          (method === "fetch" || method === "fetchRefs") && isAttemptPath(args[0], destination),
      ),
      false,
    );
    assert.equal(
      git.calls.some(
        ({ method, args }) => method === "resetToRemote" && isAttemptPath(args[0], destination),
      ),
      false,
    );
    assert.equal(
      git.calls.filter(
        ({ method, args }) => method === "remoteBranches" && isAttemptPath(args[0], destination),
      ).length,
      1,
    );
    assert.equal(files.texts.has(resolve(markerPath(destination))), true);
  });

  test("a fresh marker still resets a dirty tree without fetching", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const destination = "/home/test/.swarm/worktrees/bukhr/payroll/feat-dirty";
    const hot = hotCopyPath("/home/test/.swarm/worktrees", repo.id);
    const files = createFakeFiles({
      paths: [repo.path, hot],
      texts: {
        [markerPath(hot)]: JSON.stringify({
          fetchedAt: "2026-03-04T00:00:00.000Z",
          defaultBranch: "main",
          sha: MAIN_SHA,
          prepareFingerprint: EMPTY_PREPARE_FINGERPRINT,
        }),
      },
    });
    const git = createFakeGit({
      remoteBranches: { [destination]: ["origin/main"] },
      revisions: { [destination]: { HEAD: MAIN_SHA, "origin/main": MAIN_SHA } },
      dirtyPaths: [destination],
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
      clock: createFixedClock("2026-03-04T00:00:30.000Z"),
      logger: createNullLogger(),
    });

    await service.create({
      repoId: repo.id,
      branch: "feat/dirty",
      source: { kind: "pull", number: 2 },
    });

    assert.equal(
      git.calls.some(({ method }) => method === "fetch" || method === "fetchRefs"),
      false,
    );
    assert.ok(
      git.calls.some(
        ({ method, args }) => method === "resetToRemote" && isAttemptPath(args[0], destination),
      ),
    );
  });

  test("missing, stale, and corrupt markers are stale and trigger a narrow fetch", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const markerTexts = [
      undefined,
      JSON.stringify({
        fetchedAt: "2026-03-03T23:58:00.000Z",
        defaultBranch: "main",
        sha: MAIN_SHA,
        prepareFingerprint: EMPTY_PREPARE_FINGERPRINT,
      }),
      "{not-json",
    ];

    for (const [index, markerText] of markerTexts.entries()) {
      const branch = `feat/stale-${index}`;
      const destination = `/home/test/.swarm/worktrees/bukhr/payroll/feat-stale-${index}`;
      const hot = hotCopyPath("/home/test/.swarm/worktrees", repo.id);
      const files = createFakeFiles({
        paths: [repo.path, hot],
        texts: markerText === undefined ? undefined : { [markerPath(hot)]: markerText },
      });
      const git = createFakeGit({ remoteBranches: { [destination]: ["origin/main"] } });
      const service = createWorktreeService({
        state: createMemoryState(
          makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
        ),
        config: createMemoryConfig(),
        git,
        files,
        tmux: createFakeTmux(),
        shell: createFakeShell(),
        clock: createFixedClock("2026-03-04T00:00:00.000Z"),
        logger: createNullLogger(),
      });

      await service.create({ repoId: repo.id, branch });

      assert.ok(
        git.calls.some(
          ({ method, args }) => method === "fetchRefs" && isAttemptPath(args[0], destination),
        ),
      );
    }
  });

  test("requested-branch fetch falls back to fetching only the default branch", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const destination = "/home/test/.swarm/worktrees/bukhr/payroll/feat-existing";
    const git = createFakeGit({
      remoteBranches: { [destination]: ["origin/main", "origin/feat/existing"] },
    });
    const fetchRefs = git.fetchRefs.bind(git);
    git.fetchRefs = async (path, remote, refs, signal) => {
      await fetchRefs(path, remote, refs, signal);
      if (refs.length > 1) throw new Error("requested branch does not exist");
    };
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

    await service.create({ repoId: repo.id, branch: "feat/existing" });

    const fetchCalls = git.calls.filter(({ method }) => method === "fetchRefs");
    assert.ok(isAttemptPath(fetchCalls[0]?.args[0], destination));
    assert.deepEqual(fetchCalls[0]?.args.slice(1), [
      "origin",
      [
        "+refs/heads/main:refs/remotes/origin/main",
        "+refs/heads/feat/existing:refs/remotes/origin/feat/existing",
      ],
      undefined,
    ]);
    assert.deepEqual(fetchCalls[1]?.args.slice(1), [
      "origin",
      ["+refs/heads/main:refs/remotes/origin/main"],
      undefined,
    ]);
    assert.equal(
      git.calls.filter(
        ({ method, args }) => method === "remoteBranches" && isAttemptPath(args[0], destination),
      ).length,
      2,
    );
  });

  test("fallback clones before refreshing the destination and never refreshes the base", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const destination = "/home/test/.swarm/worktrees/bukhr/payroll/feat-order";
    const timeline: string[] = [];
    const files = createFakeFiles({ paths: [repo.path] });
    const cloneTree = files.cloneTree.bind(files);
    files.cloneTree = async (source, target) => {
      timeline.push("clone");
      await cloneTree(source, target);
    };
    const git = createFakeGit({ remoteBranches: { [destination]: ["origin/main"] } });
    const fetchRefs = git.fetchRefs.bind(git);
    git.fetchRefs = async (...args) => {
      timeline.push("fetch");
      await fetchRefs(...args);
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

    await service.create({ repoId: repo.id, branch: "feat/order" });

    assert.deepEqual(timeline.slice(0, 2), ["clone", "fetch"]);
    assert.equal(
      git.calls.some(
        ({ method, args }) =>
          (method === "fetch" || method === "fetchRefs") && args[0] === repo.path,
      ),
      false,
    );
  });

  test("the state transaction remains available while create is blocked in fetch", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const destination = "/home/test/.swarm/worktrees/bukhr/payroll/feat-concurrent";
    const fetchStarted = deferred();
    const releaseFetch = deferred();
    const state = createMemoryState(
      makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
    );
    const git = createFakeGit({ remoteBranches: { [destination]: ["origin/main"] } });
    const fetchRefs = git.fetchRefs.bind(git);
    git.fetchRefs = async (...args) => {
      await fetchRefs(...args);
      fetchStarted.resolve();
      await releaseFetch.promise;
    };
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

    const creation = service.create({ repoId: repo.id, branch: "feat/concurrent" });
    await fetchStarted.promise;
    let unrelatedMutationFinished = false;
    const unrelatedMutation = mutateState(state, (next) => {
      next.activeContextId = contexts[0]?.id;
    }).then(() => {
      unrelatedMutationFinished = true;
    });
    await flush();

    assert.equal(unrelatedMutationFinished, true);
    releaseFetch.resolve();
    await Promise.all([creation, unrelatedMutation]);
    assert.equal(state.state.worktrees.length, 1);
  });

  test("refreshPreparedCopy is deduplicated, awaitable, abortable, and rewrites its marker", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const hot = hotCopyPath("/home/test/.swarm/worktrees", repo.id);
    const fetchStarted = deferred();
    const releaseFetch = deferred();
    const git = createFakeGit({
      remoteBranches: { [hot]: ["origin/main"] },
      revisions: { [hot]: { "origin/main": MAIN_SHA } },
    });
    const fetch = git.fetch.bind(git);
    git.fetch = async (path, opts) => {
      await fetch(path, opts);
      fetchStarted.resolve();
      await releaseFetch.promise;
    };
    const files = createFakeFiles({ paths: [repo.path, hot] });
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(),
      git,
      files,
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock("2026-03-04T00:00:00.000Z"),
      logger: createNullLogger(),
    });
    const controller = new AbortController();

    const first = service.refreshPreparedCopy(repo.id, { signal: controller.signal });
    const second = service.refreshPreparedCopy(repo.id);
    await fetchStarted.promise;
    let pendingFinished = false;
    const pending = service.awaitPendingRefresh(repo.id).then(() => {
      pendingFinished = true;
    });
    await flush();
    assert.equal(pendingFinished, false);

    releaseFetch.resolve();
    await Promise.all([first, second, pending]);
    const fetchArgs = git.calls.find(({ method }) => method === "fetch")?.args;
    const internalSignal = (fetchArgs?.[1] as { signal?: AbortSignal } | undefined)?.signal;
    assert.equal(fetchArgs?.[0], hot);
    assert.ok(internalSignal);
    assert.notEqual(internalSignal, controller.signal);
    assert.deepEqual(git.calls.find(({ method }) => method === "resetToRemote")?.args, [
      hot,
      "main",
      internalSignal,
    ]);
    assert.deepEqual(JSON.parse(files.texts.get(resolve(markerPath(hot))) ?? ""), {
      fetchedAt: "2026-03-04T00:00:00.000Z",
      defaultBranch: "main",
      sha: MAIN_SHA,
      prepareFingerprint: EMPTY_PREPARE_FINGERPRINT,
    });
  });

  test("refreshPreparedCopy refreshes the base when no prepared copy exists", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const files = createFakeFiles({ paths: [repo.path] });
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

    await service.refreshPreparedCopy(repo.id);

    assert.ok(git.calls.some(({ method, args }) => method === "fetch" && args[0] === repo.path));
    assert.equal(files.texts.has(resolve(markerPath(repo.path))), false);
  });

  test("refreshPreparedCopy refreshes every existing pool slot sequentially", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const loadedConfig = { ...defaultConfig("/home/test/.swarm"), hotPoolSize: 3 };
    const hot0 = hotCopyPath(loadedConfig.worktreesDir, repo.id, 0);
    const hot2 = hotCopyPath(loadedConfig.worktreesDir, repo.id, 2);
    const git = createFakeGit({
      remoteBranches: { [hot0]: ["origin/main"], [hot2]: ["origin/main"] },
    });
    let activeFetches = 0;
    let maximumFetches = 0;
    const fetch = git.fetch.bind(git);
    git.fetch = async (path, opts) => {
      activeFetches += 1;
      maximumFetches = Math.max(maximumFetches, activeFetches);
      await fetch(path, opts);
      await flush();
      activeFetches -= 1;
    };
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(loadedConfig),
      git,
      files: createFakeFiles({ paths: [repo.path, hot0, hot2] }),
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    await service.refreshPreparedCopy(repo.id);

    assert.deepEqual(
      git.calls.filter(({ method }) => method === "fetch").map(({ args }) => args[0]),
      [hot0, hot2],
    );
    assert.equal(maximumFetches, 1);
  });

  test("periodic-style refresh skips a pool whose markers are still fresh", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const loadedConfig = { ...defaultConfig("/home/test/.swarm"), hotPoolSize: 2 };
    const hot0 = hotCopyPath(loadedConfig.worktreesDir, repo.id, 0);
    const hot1 = hotCopyPath(loadedConfig.worktreesDir, repo.id, 1);
    const marker = JSON.stringify({
      fetchedAt: "2026-03-04T00:00:00.000Z",
      defaultBranch: "main",
      sha: MAIN_SHA,
      prepareFingerprint: EMPTY_PREPARE_FINGERPRINT,
    });
    const git = createFakeGit();
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(loadedConfig),
      git,
      files: createFakeFiles({
        paths: [repo.path, hot0, hot1],
        texts: { [markerPath(hot0)]: marker, [markerPath(hot1)]: marker },
      }),
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock("2026-03-04T00:00:30.000Z"),
      logger: createNullLogger(),
    });

    await service.refreshPreparedCopy(repo.id, { skipIfFresh: true });

    assert.equal(git.calls.length, 0);
  });

  test("remoteBranches reads the lowest prepared slot after refresh", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const loadedConfig = { ...defaultConfig("/home/test/.swarm"), hotPoolSize: 3 };
    const hot1 = hotCopyPath(loadedConfig.worktreesDir, repo.id, 1);
    const hot2 = hotCopyPath(loadedConfig.worktreesDir, repo.id, 2);
    const git = createFakeGit({
      remoteBranches: {
        [repo.path]: ["origin/main"],
        [hot1]: ["origin/main", "origin/newly-fetched"],
        [hot2]: ["origin/main", "origin/other"],
      },
    });
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(loadedConfig),
      git,
      files: createFakeFiles({ paths: [repo.path, hot1, hot2] }),
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    assert.deepEqual(await service.remoteBranches(repo.id), [
      "origin/main",
      "origin/newly-fetched",
    ]);
    assert.equal(git.calls.find(({ method }) => method === "remoteBranches")?.args[0], hot1);
  });

  test("create waits for an in-flight prepared-copy refresh before consuming it", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const hot = hotCopyPath("/home/test/.swarm/worktrees", repo.id);
    const destination = "/home/test/.swarm/worktrees/bukhr/payroll/feat-refreshed";
    const fetchStarted = deferred();
    const releaseFetch = deferred();
    const git = createFakeGit({
      remoteBranches: {
        [hot]: ["origin/main"],
        [destination]: ["origin/main"],
      },
      revisions: {
        [hot]: { "origin/main": MAIN_SHA },
        [destination]: { HEAD: MAIN_SHA, "origin/main": MAIN_SHA },
      },
    });
    const fetch = git.fetch.bind(git);
    git.fetch = async (path, opts) => {
      await fetch(path, opts);
      fetchStarted.resolve();
      await releaseFetch.promise;
    };
    const files = createFakeFiles({ paths: [repo.path, hot] });
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

    const refresh = service.refreshPreparedCopy(repo.id);
    await fetchStarted.promise;
    const creation = service.create({ repoId: repo.id, branch: "feat/refreshed" });
    await flush();
    assert.equal(
      files.calls.some(
        ({ method, args }) =>
          method === "move" && args[0] === hot && isAttemptPath(args[1], destination),
      ),
      false,
    );

    releaseFetch.resolve();
    await Promise.all([refresh, creation]);
    assert.ok(
      files.calls.some(
        ({ method, args }) =>
          method === "move" && args[0] === hot && isAttemptPath(args[1], destination),
      ),
    );
    assert.equal(
      git.calls.filter(({ method }) => method === "fetch" || method === "fetchRefs").length,
      2,
      "creation explicitly fetches the requested branch after consuming the refreshed slot",
    );
  });

  test("a final registration conflict trashes the completed unregistered copy", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const branch = "feat/race";
    const slug = "feat-race";
    const destination = `/home/test/.swarm/worktrees/bukhr/payroll/${slug}`;
    const state = createMemoryState(
      makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
    );
    const files = createFakeFiles({ paths: [repo.path] });
    const git = createFakeGit({ remoteBranches: { [destination]: ["origin/main"] } });
    const checkout = git.checkoutNewBranch.bind(git);
    git.checkoutNewBranch = async (path, nextBranch, from) => {
      await checkout(path, nextBranch, from);
      files.paths.add(resolve(destination));
      files.paths.add(resolve(destination, "winner-owned"));
      await mutateState(state, (next) => {
        next.worktrees.push({
          id: `${repo.id}#${slug}`,
          repoId: repo.id,
          slug,
          branch,
          baseRef: "origin/main",
          path: destination,
          session: `${repo.name}/${slug}`,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
      });
    };
    const service = createWorktreeService({
      state,
      config: createMemoryConfig(),
      git,
      files,
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock("2026-03-04T00:00:00.000Z"),
      logger: createNullLogger(),
    });

    await assert.rejects(
      service.create({ repoId: repo.id, branch }),
      (error) => error instanceof SwarmError && error.code === "conflict",
    );

    const trashMove = files.calls.find(
      ({ method, args }) =>
        method === "move" &&
        isAttemptPath(args[0], destination) &&
        typeof args[1] === "string" &&
        args[1].startsWith("/home/test/.swarm/trash/1772582400000-feat-race-"),
    );
    assert.ok(trashMove);
    assert.ok(files.removed.includes(resolve(String(trashMove.args[1]))));
    assert.equal(files.paths.has(resolve(destination)), true);
    assert.equal(files.paths.has(resolve(destination, "winner-owned")), true);
    assert.equal(state.state.worktrees.length, 1);
  });

  test("reattaches to a live detached preparation after restart instead of deleting it", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const hot = hotCopyPath("/home/test/.swarm/worktrees", repo.id);
    const staging = hotCopyStagingPath("/home/test/.swarm/worktrees", repo.id);
    const pidPath = hotCopyPidPath("/home/test/.swarm/worktrees", repo.id);
    const files = createFakeFiles({
      paths: [repo.path, staging],
      texts: { [pidPath]: "4242\n" },
    });
    const process = createFakeProcess([
      { pid: 4242, ppid: 1, command: `sh -c hot-copy ${staging}` },
    ]);
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
      process,
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    const preparation = service.prepareHotCopy(repo.id);
    await flush();

    assert.deepEqual(git.calls, []);
    assert.equal(
      files.calls.some(({ method, args }) => method === "removeTree" && args[0] === staging),
      false,
    );
    assert.equal(
      files.calls.some(({ method }) => method === "cloneTreeDetached"),
      false,
    );

    files.paths.delete(resolve(staging));
    files.paths.add(resolve(hot));
    process.alive.delete(4242);
    await preparation;
  });

  test("dispose releases an in-flight completion poll without stopping the worker", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const destination = "/home/test/.swarm/worktrees/bukhr/payroll/feat-after-dispose";
    const staging = hotCopyStagingPath("/home/test/.swarm/worktrees", repo.id);
    const files = createFakeFiles({ paths: [repo.path] });
    const workerStarted = deferred();
    files.cloneTreeDetached = async (source, target, hot, pidPath, logPath, opts) => {
      files.calls.push({
        method: "cloneTreeDetached",
        args: [source, target, hot, pidPath, logPath, opts],
      });
      files.paths.add(resolve(target));
      await files.writeTextAtomic(pidPath, "4242\n");
      workerStarted.resolve();
      return 4242;
    };
    const process = createFakeProcess([
      { pid: 4242, ppid: 1, command: `sh -c hot-copy ${staging}` },
    ]);
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(),
      git: createFakeGit({
        remoteBranches: {
          [repo.path]: ["origin/main"],
          [destination]: ["origin/main"],
        },
      }),
      files,
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      process,
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    const preparation = service.prepareHotCopy(repo.id);
    await workerStarted.promise;
    const creation = service.create({ repoId: repo.id, branch: "feat/after-dispose" });
    await flush();
    assert.equal(
      files.calls.some(({ method }) => method === "cloneTree"),
      false,
    );

    service.dispose?.();
    await preparation;
    const created = await creation;

    assert.equal(created.path, destination);
    assert.equal(process.alive.has(4242), true);
    assert.equal(files.paths.has(resolve(staging)), true);
    assert.equal(files.calls.filter(({ method }) => method === "cloneTree").length, 1);
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
      defaultBranches: { [destination]: "main" },
      remoteBranches: {
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
      process: createFakeProcess(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    const created = await service.create({ repoId: repo.id, branch: "feat/healed" });

    assert.equal(state.state.repos[0]?.defaultBranch, "main");
    assert.equal(created.baseRef, "origin/main");
    const defaultBranchArgs = git.calls.find(({ method }) => method === "defaultBranch")?.args;
    assert.ok(isAttemptPath(defaultBranchArgs?.[0], destination));
    assert.deepEqual(defaultBranchArgs?.slice(1), ["master", undefined, ["origin/main"]]);
    const resetArgs = git.calls.find(({ method }) => method === "resetToRemote")?.args;
    assert.ok(isAttemptPath(resetArgs?.[0], destination));
    assert.deepEqual(resetArgs?.slice(1), ["main", undefined]);
  });

  test("reports a clear git error when the remote is still empty", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const destination = "/home/test/.swarm/worktrees/bukhr/payroll/feat-first";
    const git = createFakeGit({ remoteBranches: { [destination]: [] } });
    const revision = git.revision.bind(git);
    git.revision = async (path, ref, signal) => {
      if (ref === "origin/main") throw new Error("unknown revision");
      return revision(path, ref, signal);
    };
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
      process: createFakeProcess(),
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
      true,
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
      process: createFakeProcess(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    const created = await service.create({ repoId: repo.id, branch: "feat/existing" });

    assert.equal(created.baseRef, "origin/feat/existing");
    const checkoutArgs = git.calls.find((call) => call.method === "checkoutTracking")?.args;
    assert.ok(isAttemptPath(checkoutArgs?.[0], destination));
    assert.equal(checkoutArgs?.[1], "feat/existing");
  });

  test("fetches a same-repo PR head before checkout and persists its pull ref", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const destination = "/home/test/.swarm/worktrees/bukhr/payroll/feat-same-repo";
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
      process: createFakeProcess(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });
    const steps: string[] = [];

    const created = await service.create(
      { repoId: repo.id, branch: "feat/same-repo", source: { kind: "pull", number: 77 } },
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
    assert.equal(branchCalls[0]?.method, "fetchPullHead");
    assert.ok(isAttemptPath(branchCalls[0]?.args[0], destination));
    assert.deepEqual(branchCalls[0]?.args.slice(1), [77, "feat/same-repo"]);
    assert.equal(branchCalls[1]?.method, "checkoutTracking");
    assert.ok(isAttemptPath(branchCalls[1]?.args[0], destination));
    assert.deepEqual(branchCalls[1]?.args.slice(1), ["feat/same-repo"]);
    assert.equal(state.state.worktrees[0]?.baseRef, "pull/77/head");
  });

  test("finds a newly pushed branch with an explicit tracking refspec", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const branch = "feat/just-pushed";
    const destination = `/home/test/.swarm/worktrees/${repo.id}/feat-just-pushed`;
    const git = createFakeGit({ remoteBranches: { [destination]: ["origin/main"] } });
    const fetchRefs = git.fetchRefs.bind(git);
    git.fetchRefs = async (path, remote, refs, signal) => {
      await fetchRefs(path, remote, refs, signal);
      git.branches.set(path, ["origin/main", `origin/${branch}`]);
    };
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

    const created = await service.create({ repoId: repo.id, branch });

    assert.equal(created.baseRef, `origin/${branch}`);
    const fetchCall = git.calls.find(({ method }) => method === "fetchRefs");
    assert.deepEqual(fetchCall?.args[2], [
      "+refs/heads/main:refs/remotes/origin/main",
      "+refs/heads/feat/just-pushed:refs/remotes/origin/feat/just-pushed",
    ]);
    assert.ok(
      git.calls.some(
        ({ method, args }) =>
          method === "checkoutTracking" &&
          isAttemptPath(args[0], destination) &&
          args[1] === branch,
      ),
    );
  });

  test("fetches a selected non-default remote base and fails clearly when it is missing", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const destination = "/home/test/.swarm/worktrees/bukhr/payroll/feat-release";
    const git = createFakeGit({ remoteBranches: { [destination]: ["origin/main"] } });
    const fetchRefs = git.fetchRefs.bind(git);
    git.fetchRefs = async (path, remote, refs, signal) => {
      await fetchRefs(path, remote, refs, signal);
      git.branches.set(path, ["origin/main", "origin/release"]);
    };
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

    const created = await service.create({
      repoId: repo.id,
      branch: "feat/release",
      baseRef: "origin/release",
    });

    assert.equal(created.baseRef, "origin/release");
    const fetchedRefs = git.calls.find(({ method }) => method === "fetchRefs")?.args[2];
    assert.ok(Array.isArray(fetchedRefs));
    assert.ok(fetchedRefs.includes("+refs/heads/release:refs/remotes/origin/release"));

    const missingGit = createFakeGit({ remoteBranches: { [destination]: ["origin/main"] } });
    missingGit.fetchRefs = async () => {
      throw new Error("remote ref does not exist");
    };
    const missingService = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(),
      git: missingGit,
      files: createFakeFiles({ paths: [repo.path] }),
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });
    await assert.rejects(
      missingService.create({
        repoId: repo.id,
        branch: "feat/release",
        baseRef: "origin/release",
      }),
      (error) =>
        error instanceof SwarmError &&
        error.message === "Failed to fetch base ref 'origin/release' for bukhr/payroll",
    );
  });

  test("parallel creates atomically claim different pool slots", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const loadedConfig = { ...defaultConfig("/home/test/.swarm"), hotPoolSize: 2 };
    const hot0 = hotCopyPath(loadedConfig.worktreesDir, repo.id, 0);
    const hot1 = hotCopyPath(loadedConfig.worktreesDir, repo.id, 1);
    const firstDestination = `${loadedConfig.worktreesDir}/${repo.id}/feat-one`;
    const secondDestination = `${loadedConfig.worktreesDir}/${repo.id}/feat-two`;
    const files = createFakeFiles({ paths: [repo.path, hot0, hot1] });
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(loadedConfig),
      git: createFakeGit({
        remoteBranches: {
          [firstDestination]: ["origin/main"],
          [secondDestination]: ["origin/main"],
        },
      }),
      files,
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    await Promise.all([
      service.create({ repoId: repo.id, branch: "feat/one" }),
      service.create({ repoId: repo.id, branch: "feat/two" }),
    ]);

    const claims = files.calls.filter(
      ({ method, args }) => method === "move" && (args[0] === hot0 || args[0] === hot1),
    );
    assert.deepEqual(new Set(claims.map(({ args }) => args[0])), new Set([hot0, hot1]));
    assert.equal(
      files.calls.some(({ method }) => method === "cloneTree"),
      false,
    );
  });

  test("a second parallel create falls back after the only slot is claimed", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const hot = hotCopyPath("/home/test/.swarm/worktrees", repo.id);
    const firstDestination = `/home/test/.swarm/worktrees/${repo.id}/feat-one`;
    const secondDestination = `/home/test/.swarm/worktrees/${repo.id}/feat-two`;
    const files = createFakeFiles({ paths: [repo.path, hot] });
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(),
      git: createFakeGit({
        remoteBranches: {
          [firstDestination]: ["origin/main"],
          [secondDestination]: ["origin/main"],
        },
      }),
      files,
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    await Promise.all([
      service.create({ repoId: repo.id, branch: "feat/one" }),
      service.create({ repoId: repo.id, branch: "feat/two" }),
    ]);

    assert.equal(
      files.calls.filter(({ method, args }) => method === "move" && args[0] === hot).length,
      2,
      "both creators try the slot and the second observes ENOENT",
    );
    assert.equal(
      files.calls.filter(({ method, args }) => method === "cloneTree" && args[0] === repo.path)
        .length,
      1,
    );
  });

  test("a refresh started during creation waits for the slot claim mutex", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const hot = hotCopyPath("/home/test/.swarm/worktrees", repo.id);
    const destination = `/home/test/.swarm/worktrees/${repo.id}/feat-mutex`;
    const claimStarted = deferred();
    const releaseClaim = deferred();
    const files = createFakeFiles({ paths: [repo.path, hot] });
    const move = files.move.bind(files);
    files.move = async (source, target) => {
      if (source === hot) {
        claimStarted.resolve();
        await releaseClaim.promise;
      }
      await move(source, target);
    };
    const git = createFakeGit({ remoteBranches: { [destination]: ["origin/main"] } });
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

    const creation = service.create({ repoId: repo.id, branch: "feat/mutex" });
    await claimStarted.promise;
    const refresh = service.refreshPreparedCopy(repo.id);
    await flush();
    assert.equal(
      git.calls.some(({ method }) => method === "fetch" || method === "fetchRefs"),
      false,
    );

    releaseClaim.resolve();
    await Promise.all([creation, refresh]);
  });

  test("refresh reruns prepare hooks after resetting a prepared copy", async () => {
    const fixture = repos[0];
    assert.ok(fixture);
    const repo = { ...fixture, hooks: { prepare: ["npm ci"], postCreate: [] } };
    const hot = hotCopyPath("/home/test/.swarm/worktrees", repo.id);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(repo.hooks.prepare))
      .digest("hex");
    const timeline: string[] = [];
    const git = createFakeGit({
      remoteBranches: { [hot]: ["origin/main"] },
      revisions: { [hot]: { HEAD: "b".repeat(40), "origin/main": MAIN_SHA } },
    });
    const reset = git.resetToRemote.bind(git);
    git.resetToRemote = async (...args) => {
      timeline.push("reset");
      await reset(...args);
    };
    const shell = createFakeShell([
      {
        match: (_cmd, args) => args[1] === "npm ci",
        result: () => {
          timeline.push("prepare");
          return {};
        },
      },
    ]);
    const files = createFakeFiles({
      paths: [repo.path, hot],
      texts: {
        [markerPath(hot)]: JSON.stringify({
          fetchedAt: "2026-03-04T00:00:00.000Z",
          defaultBranch: "main",
          sha: MAIN_SHA,
          prepareFingerprint: fingerprint,
        }),
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
      shell,
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    await service.refreshPreparedCopy(repo.id);

    assert.deepEqual(timeline, ["reset", "prepare"]);
  });

  test("an abort during prepare hooks clears freshness and the next claim re-prepares", async () => {
    const fixture = repos[0];
    assert.ok(fixture);
    const repo = { ...fixture, hooks: { prepare: ["prepare deps"], postCreate: [] } };
    const hot = hotCopyPath("/home/test/.swarm/worktrees", repo.id);
    const destination = "/home/test/.swarm/worktrees/bukhr/payroll/feat-after-abort";
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(repo.hooks.prepare))
      .digest("hex");
    const files = createFakeFiles({
      paths: [repo.path, hot],
      texts: {
        [markerPath(hot)]: JSON.stringify({
          fetchedAt: "2026-03-04T00:00:00.000Z",
          defaultBranch: "main",
          sha: MAIN_SHA,
          prepareFingerprint: fingerprint,
        }),
      },
    });
    const git = createFakeGit({
      remoteBranches: { [hot]: ["origin/main"], [destination]: ["origin/main"] },
      revisions: {
        [hot]: { HEAD: "b".repeat(40), "origin/main": MAIN_SHA },
        [destination]: { HEAD: MAIN_SHA, "origin/main": MAIN_SHA },
      },
    });
    const hookStarted = deferred();
    let hookRuns = 0;
    const shell = createFakeShell();
    shell.run = async (cmd, args, opts) => {
      shell.calls.push({ cmd, args: [...args], opts });
      hookRuns += 1;
      if (hookRuns > 1) return { code: 0, stdout: "", stderr: "" };
      hookStarted.resolve();
      return await new Promise((_resolveResult, rejectResult) => {
        opts?.signal?.addEventListener(
          "abort",
          () => rejectResult(new SwarmError("cancelled", "hook cancelled")),
          { once: true },
        );
        if (opts?.signal?.aborted) rejectResult(new SwarmError("cancelled", "hook cancelled"));
      });
    };
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(),
      git,
      files,
      tmux: createFakeTmux(),
      shell,
      clock: createFixedClock(),
      logger: createNullLogger(),
    });
    const controller = new AbortController();

    const refresh = service.refreshPreparedCopy(repo.id, { signal: controller.signal });
    await hookStarted.promise;
    controller.abort();
    await assert.rejects(
      refresh,
      (error) => error instanceof SwarmError && error.code === "cancelled",
    );
    await service.awaitPendingRefresh(repo.id).catch(() => undefined);
    assert.equal(files.texts.has(resolve(markerPath(hot))), false);

    await service.create({ repoId: repo.id, branch: "feat/after-abort" });
    assert.equal(hookRuns, 2);
  });

  test("removing prepare hooks rebuilds the slot and drops old ignored artifacts", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const hot = hotCopyPath("/home/test/.swarm/worktrees", repo.id);
    const artifact = join(hot, "vendor", "old-hook-output");
    const oldFingerprint = createHash("sha256").update('["generate artifact"]').digest("hex");
    const files = createFakeFiles({
      paths: [repo.path, join(repo.path, ".git"), hot, artifact],
      texts: {
        [markerPath(hot)]: JSON.stringify({
          fetchedAt: "2026-03-04T00:00:00.000Z",
          defaultBranch: "main",
          sha: MAIN_SHA,
          prepareFingerprint: oldFingerprint,
        }),
      },
    });
    const git = createFakeGit({
      remoteBranches: { [repo.path]: ["origin/main"] },
      revisions: { [repo.path]: { HEAD: MAIN_SHA, "origin/main": MAIN_SHA } },
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

    await service.refreshPreparedCopy(repo.id);

    assert.equal(files.paths.has(resolve(artifact)), false);
    assert.ok(
      files.calls.some(
        ({ method, args }) =>
          method === "cloneTree" &&
          args[0] === repo.path &&
          args[1] === hotCopyStagingPath("/home/test/.swarm/worktrees", repo.id),
      ),
    );
    assert.equal(files.paths.has(resolve(hot)), true);
  });

  test("a changed prepare-hook fingerprint reruns hooks on refresh and claim", async () => {
    const fixture = repos[0];
    assert.ok(fixture);
    const repo = { ...fixture, hooks: { prepare: ["npm ci"], postCreate: [] } };
    const loadedConfig = { ...defaultConfig("/home/test/.swarm"), hotPoolSize: 2 };
    const hot0 = hotCopyPath(loadedConfig.worktreesDir, repo.id, 0);
    const hot1 = hotCopyPath(loadedConfig.worktreesDir, repo.id, 1);
    const destination = `${loadedConfig.worktreesDir}/${repo.id}/feat-fingerprint`;
    const oldMarker = JSON.stringify({
      fetchedAt: "2026-03-04T00:00:00.000Z",
      defaultBranch: "main",
      sha: MAIN_SHA,
      prepareFingerprint: "0".repeat(64),
    });
    const files = createFakeFiles({
      paths: [repo.path, hot0, hot1],
      texts: { [markerPath(hot0)]: oldMarker, [markerPath(hot1)]: oldMarker },
    });
    const git = createFakeGit({
      remoteBranches: {
        [repo.path]: ["origin/main"],
        [hot0]: ["origin/main"],
        [hot1]: ["origin/main"],
        [destination]: ["origin/main"],
      },
      revisions: {
        [repo.path]: { HEAD: MAIN_SHA, "origin/main": MAIN_SHA },
        [hot0]: { HEAD: MAIN_SHA, "origin/main": MAIN_SHA },
        [hot1]: { HEAD: MAIN_SHA, "origin/main": MAIN_SHA },
        [destination]: { HEAD: MAIN_SHA, "origin/main": MAIN_SHA },
      },
    });
    const shell = createFakeShell([{ match: (_cmd, args) => args[1] === "npm ci", result: {} }]);
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(loadedConfig),
      git,
      files,
      tmux: createFakeTmux(),
      shell,
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    await service.refreshPreparedCopy(repo.id);
    assert.equal(shell.calls.filter(({ args }) => args[1] === "npm ci").length, 2);

    shell.calls.length = 0;
    files.texts.set(resolve(markerPath(hot0)), oldMarker);
    await service.create({ repoId: repo.id, branch: "feat/fingerprint" });
    const hookCall = shell.calls.find(({ args }) => args[1] === "npm ci");
    assert.ok(isAttemptPath(hookCall?.opts?.cwd, destination));
    assert.equal(
      git.calls.some(
        ({ method, args }) => method === "resetToRemote" && isAttemptPath(args[0], destination),
      ),
      false,
    );
  });

  test("post-create hooks use one detached runner and surface every hook record", async () => {
    const fixture = repos[1];
    const worktree = worktrees[3];
    assert.ok(fixture);
    assert.ok(worktree);
    const repo = {
      ...fixture,
      hooks: { prepare: [], postCreate: ["first hook", "second hook", "third hook"] },
    };
    const files = createFakeFiles();
    const shell = createFakeShell();
    shell.runDetachedLogged = async (cmd, args, opts) => {
      const call = { cmd, args: [...args], opts };
      shell.calls.push(call);
      shell.detachedLoggedCalls.push(call);
      const recordsPath = args[3];
      assert.ok(recordsPath);
      await files.writeTextAtomic(
        recordsPath,
        [
          "start\t1\t1",
          "end\t1\t0\t12",
          "start\t2\t1",
          "end\t2\t9\t25",
          "start\t3\t1",
          "end\t3\t0\t3",
          "",
        ].join("\n"),
      );
      return 0;
    };
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [worktree] }),
      ),
      config: createMemoryConfig(),
      git: createFakeGit(),
      files,
      tmux: createFakeTmux(),
      shell,
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    const steps: string[] = [];
    const logs: string[] = [];
    await service.runPostCreateHooks(worktree.id, (event) => {
      if (event.type === "step") steps.push(event.label);
      if (event.type === "log") logs.push(event.line);
    });

    assert.equal(shell.detachedLoggedCalls.length, 1);
    assert.equal(shell.detachedLoggedCalls[0]?.cmd, "sh");
    for (const command of repo.hooks.postCreate) {
      assert.ok(shell.detachedLoggedCalls[0]?.args.includes(command));
      assert.ok(logs.includes(`$ ${command}`));
    }
    assert.deepEqual(steps, [
      "Running post-create hook 1/3",
      "Running post-create hook 2/3",
      "Running post-create hook 3/3",
    ]);
    assert.ok(logs.includes("Hook failed (9): second hook"));
    assert.ok(logs.includes("Running post-create hook 2/3 25ms"));
    assert.deepEqual(shell.detachedLoggedCalls[0]?.opts, {
      cwd: worktree.path,
      logPath: "/home/test/.swarm/logs/swarm.log",
    });
  });

  test("a forced refresh queues behind a freshness-skipping refresh", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const hot = hotCopyPath("/home/test/.swarm/worktrees", repo.id);
    const marker = JSON.stringify({
      fetchedAt: "2026-03-04T00:00:00.000Z",
      defaultBranch: "main",
      sha: MAIN_SHA,
      prepareFingerprint: EMPTY_PREPARE_FINGERPRINT,
    });
    const readStarted = deferred();
    const releaseRead = deferred();
    const files = createFakeFiles({
      paths: [repo.path, hot],
      texts: { [markerPath(hot)]: marker },
    });
    const readText = files.readText.bind(files);
    let firstRead = true;
    files.readText = async (path) => {
      if (firstRead) {
        firstRead = false;
        readStarted.resolve();
        await releaseRead.promise;
      }
      return readText(path);
    };
    const git = createFakeGit({ remoteBranches: { [hot]: ["origin/main"] } });
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(),
      git,
      files,
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock("2026-03-04T00:00:30.000Z"),
      logger: createNullLogger(),
    });

    const skipping = service.refreshPreparedCopy(repo.id, { skipIfFresh: true });
    await readStarted.promise;
    const forced = service.refreshPreparedCopy(repo.id, { skipIfFresh: false });
    releaseRead.resolve();
    await Promise.all([skipping, forced]);

    assert.equal(git.calls.filter(({ method }) => method === "fetch").length, 1);
  });

  test("one refresh caller can abort without cancelling another caller", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const hot = hotCopyPath("/home/test/.swarm/worktrees", repo.id);
    const fetchStarted = deferred();
    const releaseFetch = deferred();
    let internalSignal: AbortSignal | undefined;
    const git = createFakeGit({ remoteBranches: { [hot]: ["origin/main"] } });
    const fetch = git.fetch.bind(git);
    git.fetch = async (path, opts) => {
      internalSignal = opts?.signal;
      fetchStarted.resolve();
      await releaseFetch.promise;
      await fetch(path, opts);
    };
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(),
      git,
      files: createFakeFiles({ paths: [repo.path, hot] }),
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });
    const caller = new AbortController();

    const first = service.refreshPreparedCopy(repo.id, { signal: caller.signal });
    const second = service.refreshPreparedCopy(repo.id);
    await fetchStarted.promise;
    caller.abort();
    await assert.rejects(
      first,
      (error) => error instanceof SwarmError && error.code === "cancelled",
    );
    assert.equal(internalSignal?.aborted, false);
    releaseFetch.resolve();
    await second;
  });

  test("replenishment removes slots above the configured pool size", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const loadedConfig = { ...defaultConfig("/home/test/.swarm"), hotPoolSize: 1 };
    const hot0 = hotCopyPath(loadedConfig.worktreesDir, repo.id, 0);
    const hot2 = hotCopyPath(loadedConfig.worktreesDir, repo.id, 2);
    const staging2 = hotCopyStagingPath(loadedConfig.worktreesDir, repo.id, 2);
    const files = createFakeFiles({ paths: [repo.path, hot0, hot2, staging2] });
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(loadedConfig),
      git: createFakeGit(),
      files,
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    await service.prepareHotCopy(repo.id);

    assert.equal(files.paths.has(resolve(hot0)), true);
    assert.equal(files.paths.has(resolve(hot2)), false);
    assert.equal(files.paths.has(resolve(staging2)), false);
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
      process: createFakeProcess(),
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
      ".hot.1",
      ".hot.1.staging",
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
      process: createFakeProcess(),
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
      process: createFakeProcess(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });
    await assert.rejects(
      pathService.create({ repoId: repo.id, branch: "new" }),
      (error) => error instanceof SwarmError && error.code === "conflict",
    );
  });

  test("rejects a local create when the id belongs to a remote mirror", async () => {
    const repo = repos[0];
    const source = worktrees[0];
    assert.ok(repo && source);
    const mirror = { ...source, host: "devbox" };
    const git = createFakeGit();
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [mirror] }),
      ),
      config: createMemoryConfig(),
      git,
      files: createFakeFiles({ paths: [repo.path] }),
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      process: createFakeProcess(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    await assert.rejects(service.create({ repoId: repo.id, branch: source.branch }), (error) => {
      assert.ok(error instanceof SwarmError);
      assert.equal(error.code, "validation");
      assert.equal(error.message, `Worktree already exists: ${mirror.id}`);
      return true;
    });
    assert.deepEqual(git.calls, []);
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
      process: createFakeProcess(),
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
      process: createFakeProcess(),
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
      process: createFakeProcess(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    await assert.rejects(
      service.create({ repoId: repo.id, branch: "feat/broken" }),
      (error) => error instanceof SwarmError && error.code === "git",
    );
    assert.equal(files.removed.length, 1);
    assert.ok(isAttemptPath(files.removed[0], destination));
  });

  test("removes an attempt when cloning creates content and then fails", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const destination = "/home/test/.swarm/worktrees/bukhr/payroll/feat-clone-fails";
    const files = createFakeFiles({ paths: [repo.path] });
    files.cloneTree = async (_source, attempt) => {
      files.paths.add(resolve(attempt));
      files.paths.add(resolve(attempt, ".git"));
      throw new Error("copy interrupted");
    };
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(),
      git: createFakeGit(),
      files,
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    await assert.rejects(service.create({ repoId: repo.id, branch: "feat/clone-fails" }));

    assert.equal(
      [...files.paths].some((path) => isAttemptPath(path, destination)),
      false,
    );
    assert.ok(files.removed.some((path) => isAttemptPath(path, destination)));
  });

  test("startup reconciliation registers complete matching intents and trashes mismatches", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const goodPath = "/home/test/.swarm/worktrees/bukhr/payroll/feat-recovered";
    const badPath = "/home/test/.swarm/worktrees/bukhr/payroll/feat-invalid";
    const state = createMemoryState(
      makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
    );
    const marker = (id: string, branch: string) =>
      JSON.stringify({
        id,
        repoId: repo.id,
        branch,
        baseRef: "origin/main",
        createdAt: "2026-03-04T00:00:00.000Z",
      });
    const files = createFakeFiles({
      paths: [repo.path, goodPath, badPath],
      texts: {
        [creatingMarkerPath(goodPath)]: marker(`${repo.id}#feat-recovered`, "feat/recovered"),
        [creatingMarkerPath(badPath)]: marker(`${repo.id}#feat-invalid`, "feat/invalid"),
      },
    });
    const service = createWorktreeService({
      state,
      config: createMemoryConfig(),
      git: createFakeGit({
        currentBranches: { [goodPath]: "feat/recovered", [badPath]: "wrong-branch" },
      }),
      files,
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock("2026-03-04T00:00:00.000Z"),
      logger: createNullLogger(),
    });

    await service.reconcileCreating();

    assert.equal(state.state.worktrees.length, 1);
    assert.equal(state.state.worktrees[0]?.path, goodPath);
    assert.equal(files.paths.has(resolve(goodPath)), true);
    assert.equal(files.texts.has(resolve(creatingMarkerPath(goodPath))), false);
    assert.equal(files.paths.has(resolve(badPath)), false);
    assert.ok(
      files.calls.some(
        ({ method, args }) =>
          method === "move" && args[0] === badPath && String(args[1]).includes("trash"),
      ),
    );
  });

  test("startup reconciliation reads no marker when .git is not a directory", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const linkedPath = "/home/test/.swarm/worktrees/bukhr/payroll/feat-linked";
    const state = createMemoryState(
      makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
    );
    const files = createFakeFiles({ paths: [repo.path, linkedPath] });
    const readText = files.readText.bind(files);
    files.readText = async (path) => {
      if (resolve(path) === resolve(creatingMarkerPath(linkedPath))) {
        throw new SwarmError("fs", `Could not read ${path}`, {
          cause: Object.assign(new Error("ENOTDIR: not a directory"), { code: "ENOTDIR" }),
        });
      }
      return readText(path);
    };
    const service = createWorktreeService({
      state,
      config: createMemoryConfig(),
      git: createFakeGit(),
      files,
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock("2026-03-04T00:00:00.000Z"),
      logger: createNullLogger(),
    });

    await service.reconcileCreating();

    assert.deepEqual(state.state.worktrees, []);
    assert.equal(files.paths.has(resolve(linkedPath)), true);
    assert.equal(
      files.calls.some(({ method }) => method === "move" || method === "removeDetached"),
      false,
    );
  });

  test("preflight reclaims an orphan intent and publish writes a new intent before rename", async () => {
    const repo = repos[0];
    assert.ok(repo);
    const destination = "/home/test/.swarm/worktrees/bukhr/payroll/feat-reclaim";
    const files = createFakeFiles({
      paths: [repo.path, destination],
      texts: {
        [creatingMarkerPath(destination)]: '{"interrupted":true}',
      },
    });
    const move = files.move.bind(files);
    let markerSeenBeforePublish = false;
    files.move = async (source, target) => {
      if (target === destination && isAttemptPath(source, destination)) {
        markerSeenBeforePublish = files.texts.has(resolve(creatingMarkerPath(source)));
      }
      await move(source, target);
    };
    const service = createWorktreeService({
      state: createMemoryState(
        makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] }),
      ),
      config: createMemoryConfig(),
      git: createFakeGit({ remoteBranches: { [destination]: ["origin/main"] } }),
      files,
      tmux: createFakeTmux(),
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
    });

    const created = await service.create({ repoId: repo.id, branch: "feat/reclaim" });

    assert.equal(created.path, destination);
    assert.equal(markerSeenBeforePublish, true);
    assert.equal(files.texts.has(resolve(creatingMarkerPath(destination))), false);
    assert.ok(
      files.calls.some(
        ({ method, args }) =>
          method === "move" && args[0] === destination && String(args[1]).includes("trash"),
      ),
    );
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
      process: createFakeProcess(),
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

  test("routes remote deletion before removing its proxy and mirror", async () => {
    const source = worktrees[0];
    assert.ok(source);
    const target = { ...source, host: "devbox", path: "/srv/worktrees/payroll/main" };
    const state = createMemoryState(makeState({ worktrees: [target] }));
    const tmux = createFakeTmux({
      sessions: [
        {
          name: "devbox/payroll/main",
          attached: false,
          windows: 1,
          createdAt: 0,
          lastActivityAt: 0,
        },
      ],
    });
    const calls: string[] = [];
    let failure: SwarmError | undefined;
    const remoteHosts = {
      async delete(hostId: string, worktreeId: string) {
        calls.push(`${hostId}:${worktreeId}`);
        if (failure) throw failure;
      },
    } as unknown as RemoteHostService;
    const service = createWorktreeService({
      state,
      config: createMemoryConfig(),
      git: createFakeGit(),
      files: createFakeFiles(),
      tmux,
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
      remoteHosts,
    });

    failure = new SwarmError("remote", "devbox unreachable: offline");
    await assert.rejects(service.delete(target.id), failure);
    assert.deepEqual(state.state.worktrees, [target]);
    assert.equal(tmux.sessions.has("devbox/payroll/main"), true);

    failure = undefined;
    await service.delete(target.id);
    assert.deepEqual(calls, [`devbox:${target.id}`, `devbox:${target.id}`]);
    assert.deepEqual(state.state.worktrees, []);
    assert.equal(tmux.sessions.has("devbox/payroll/main"), false);
  });

  test("remote deletion removes the mirror when its proxy vanishes during teardown", async () => {
    const source = worktrees[0];
    assert.ok(source);
    const target = { ...source, host: "devbox", path: "/srv/worktrees/payroll/main" };
    const state = createMemoryState(makeState({ worktrees: [target] }));
    const tmux = createFakeTmux({
      sessions: [
        {
          name: "devbox/payroll/main",
          attached: false,
          windows: 1,
          createdAt: 0,
          lastActivityAt: 0,
        },
      ],
    });
    const remoteHosts = {
      async delete() {
        tmux.sessions.delete("devbox/payroll/main");
      },
    } as unknown as RemoteHostService;
    const service = createWorktreeService({
      state,
      config: createMemoryConfig(),
      git: createFakeGit(),
      files: createFakeFiles(),
      tmux,
      shell: createFakeShell(),
      clock: createFixedClock(),
      logger: createNullLogger(),
      remoteHosts,
    });

    await service.delete(target.id);

    assert.deepEqual(state.state.worktrees, []);
    assert.ok(tmux.calls.some(({ method }) => method === "killSessionIfPresent"));
  });
});
