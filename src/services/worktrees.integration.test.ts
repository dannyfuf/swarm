import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFiles } from "../adapters/files.ts";
import { createShell } from "../adapters/shell.ts";
import { createStateStore } from "../adapters/state.ts";
import { hotCopyPath } from "../core/paths.ts";
import type { FilesPort, StatePort } from "../core/ports.ts";
import { type Config, defaultConfig, type Repo, type State } from "../core/types.ts";
import { createFakeGit } from "../testing/fakeGit.ts";
import { createFakeProcess } from "../testing/fakeProcess.ts";
import { createFakeShell } from "../testing/fakeShell.ts";
import { createFakeTmux } from "../testing/fakeTmux.ts";
import { createFixedClock } from "../testing/fixedClock.ts";
import { contexts, makeState, repos } from "../testing/fixtures.ts";
import { createMemoryConfig } from "../testing/memoryConfig.ts";
import { createNullLogger } from "../testing/nullLogger.ts";
import { createWorktreeService } from "./worktrees.ts";

interface RealHarness {
  root: string;
  files: FilesPort;
  config: Config;
  repo: Repo;
  statePath: string;
  initialState: State;
}

async function makeRealHarness(): Promise<RealHarness> {
  const root = await mkdtemp(join(tmpdir(), "swarm-worktrees-"));
  const logger = createNullLogger();
  const files = createFiles(createShell(logger), logger, process.platform, [root]);
  const config: Config = {
    ...defaultConfig(root),
    reposDir: join(root, "repos"),
    worktreesDir: join(root, "worktrees"),
    hotPoolSize: 1,
  };
  const fixture = repos[0];
  assert.ok(fixture);
  const repo: Repo = { ...fixture, path: join(config.reposDir, fixture.id) };
  await mkdir(join(repo.path, ".git"), { recursive: true });
  await writeFile(join(repo.path, "tracked.txt"), "base\n", "utf8");
  const initialState = makeState({ contexts: [contexts[0]], repos: [repo], worktrees: [] });
  const statePath = join(root, "state.json");
  await writeFile(statePath, JSON.stringify(initialState), "utf8");
  return { root, files, config, repo, statePath, initialState };
}

function makeStatePort(harness: RealHarness): StatePort {
  const processPort = createFakeProcess();
  processPort.alive.add(process.pid);
  return createStateStore(harness.files, harness.statePath, createNullLogger(), {
    process: processPort,
    lockRetryMs: 1,
  });
}

function makeService(harness: RealHarness, state: StatePort) {
  const git = createFakeGit();
  git.remoteBranches = async (path, signal) => {
    git.calls.push({ method: "remoteBranches", args: [path, signal] });
    return ["origin/main"];
  };
  return createWorktreeService({
    state,
    config: createMemoryConfig(harness.config),
    git,
    files: harness.files,
    tmux: createFakeTmux(),
    shell: createFakeShell(),
    clock: createFixedClock("2026-03-04T00:00:00.000Z"),
    logger: createNullLogger(),
    home: harness.root,
  });
}

async function waitForRemoval(path: string, files: FilesPort): Promise<void> {
  for (let attempt = 0; attempt < 100 && (await files.exists(path)); attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

test("real state lock lets exactly one same-slug create win without a loser directory", async (t) => {
  const harness = await makeRealHarness();
  t.after(() => rm(harness.root, { recursive: true, force: true }));
  const first = makeService(harness, makeStatePort(harness));
  const second = makeService(harness, makeStatePort(harness));

  const results = await Promise.allSettled([
    first.create({ repoId: harness.repo.id, branch: "feat/race" }),
    second.create({ repoId: harness.repo.id, branch: "feat/race" }),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const root = join(harness.config.worktreesDir, harness.repo.id);
  const destination = join(root, "feat-race");
  await waitForRemoval(`${destination}.creating`, harness.files);
  const names = await readdir(root);
  assert.deepEqual(
    names.filter((name) => name.startsWith("feat-race")),
    ["feat-race"],
  );
  assert.equal((await makeStatePort(harness).load()).worktrees.length, 1);
});

test("two real-files creators share one slot and the other falls back to cloning", async (t) => {
  const harness = await makeRealHarness();
  t.after(() => rm(harness.root, { recursive: true, force: true }));
  const hot = hotCopyPath(harness.config.worktreesDir, harness.repo.id);
  await mkdir(join(hot, ".git"), { recursive: true });
  await writeFile(join(hot, "tracked.txt"), "prepared\n", "utf8");
  const first = makeService(harness, makeStatePort(harness));
  const second = makeService(harness, makeStatePort(harness));
  let claims = 0;
  const onEvent = (event: { type: string }): void => {
    if (event.type === "prepared-copy-claimed") claims += 1;
  };

  await Promise.all([
    first.create({ repoId: harness.repo.id, branch: "feat/one" }, onEvent),
    second.create({ repoId: harness.repo.id, branch: "feat/two" }, onEvent),
  ]);

  assert.equal(claims, 1);
  const persisted = await makeStatePort(harness).load();
  assert.deepEqual(persisted.worktrees.map((worktree) => worktree.slug).sort(), [
    "feat-one",
    "feat-two",
  ]);
  assert.equal(await harness.files.exists(join(harness.repo.path, "tracked.txt")), true);
});

test("a real-state write failure after publish rolls the destination back", async (t) => {
  const harness = await makeRealHarness();
  t.after(() => rm(harness.root, { recursive: true, force: true }));
  const failingStateFiles: FilesPort = {
    ...harness.files,
    async writeTextAtomic(path, text) {
      if (path === harness.statePath) throw new Error("injected state write failure");
      await harness.files.writeTextAtomic(path, text);
    },
  };
  const processPort = createFakeProcess();
  processPort.alive.add(process.pid);
  const state = createStateStore(failingStateFiles, harness.statePath, createNullLogger(), {
    process: processPort,
    lockRetryMs: 1,
  });
  const service = makeService(harness, state);
  const destination = join(harness.config.worktreesDir, harness.repo.id, "feat-rollback");

  await assert.rejects(service.create({ repoId: harness.repo.id, branch: "feat/rollback" }));
  await waitForRemoval(destination, harness.files);

  assert.equal(await harness.files.exists(destination), false);
  assert.deepEqual((await makeStatePort(harness).load()).worktrees, []);
  const root = join(harness.config.worktreesDir, harness.repo.id);
  const names = await readdir(root).catch(() => [] as string[]);
  assert.equal(
    names.some((name) => name.startsWith("feat-rollback")),
    false,
  );
});
