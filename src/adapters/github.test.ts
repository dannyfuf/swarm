import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import { SwarmError } from "../core/errors.ts";
import type { RemoteRepo } from "../core/types.ts";
import { createFakeFiles } from "../testing/fakeFiles.ts";
import { createFakeShell } from "../testing/fakeShell.ts";
import { createFixedClock } from "../testing/fixedClock.ts";
import { createNullLogger } from "../testing/nullLogger.ts";
import { createGithub } from "./github.ts";

const cacheDir = "/cache/github";
const now = "2026-01-01T12:00:00.000Z";

const cachedRepo: RemoteRepo = {
  owner: "acme",
  name: "cached",
  fullName: "acme/cached",
  description: "Cached repo",
  sshUrl: "git@github.com:acme/cached.git",
  isPrivate: true,
  updatedAt: "2025-12-31T00:00:00.000Z",
  defaultBranch: "main",
};

function cache(fetchedAt: string, repos: RemoteRepo[] = [cachedRepo]): string {
  return JSON.stringify({ fetchedAt, repos });
}

function ghRepoJson(name = "live"): string {
  return JSON.stringify([
    {
      name,
      owner: { login: "acme" },
      nameWithOwner: `acme/${name}`,
      description: null,
      sshUrl: `git@github.com:acme/${name}.git`,
      isPrivate: false,
      updatedAt: "2026-01-01T10:00:00.000Z",
      defaultBranchRef: null,
    },
  ]);
}

function createAdapter(
  files = createFakeFiles(),
  shell = createFakeShell(),
  logger = createNullLogger(),
) {
  return {
    github: createGithub(shell, files, logger, {
      cacheDir,
      cacheTtlSeconds: 3600,
      clock: createFixedClock(now),
    }),
    files,
    shell,
    logger,
  };
}

describe("GitHub adapter", () => {
  test("viewer asks gh for the current login", async () => {
    const shell = createFakeShell([
      {
        match: (cmd, args) => cmd === "gh" && args.join(" ") === "api user --jq .login",
        result: { stdout: "octocat\n" },
      },
    ]);
    const { github } = createAdapter(createFakeFiles(), shell);

    assert.deepEqual(await github.viewer(), { login: "octocat" });
  });

  test("returns a fresh cache without calling gh", async () => {
    const files = createFakeFiles({
      texts: { [`${cacheDir}/acme.json`]: cache("2026-01-01T11:30:00.000Z") },
    });
    const { github, shell } = createAdapter(files);

    assert.deepEqual(await github.listRepos("acme"), [cachedRepo]);
    assert.equal(shell.calls.length, 0);
  });

  test("fetches and atomically caches a cache miss", async () => {
    const shell = createFakeShell([
      {
        match: (cmd, args) => cmd === "gh" && args.slice(0, 3).join(" ") === "repo list acme",
        result: { stdout: ghRepoJson() },
      },
    ]);
    const { github, files } = createAdapter(createFakeFiles(), shell);

    const repos = await github.listRepos("acme");

    assert.deepEqual(repos, [
      {
        owner: "acme",
        name: "live",
        fullName: "acme/live",
        description: "",
        sshUrl: "git@github.com:acme/live.git",
        isPrivate: false,
        updatedAt: "2026-01-01T10:00:00.000Z",
        defaultBranch: "main",
      },
    ]);
    assert.equal(shell.calls.length, 1);
    assert.equal(
      shell.calls[0]?.args.at(-1),
      "name,owner,nameWithOwner,description,sshUrl,isPrivate,updatedAt,defaultBranchRef",
    );
    assert.deepEqual(JSON.parse(files.texts.get(resolve(`${cacheDir}/acme.json`)) ?? ""), {
      fetchedAt: now,
      repos,
    });
  });

  test("refreshes a stale cache", async () => {
    const files = createFakeFiles({
      texts: { [`${cacheDir}/acme.json`]: cache("2025-12-31T00:00:00.000Z") },
    });
    const shell = createFakeShell([
      { match: (cmd) => cmd === "gh", result: { stdout: ghRepoJson("refreshed") } },
    ]);
    const { github } = createAdapter(files, shell);

    assert.equal((await github.listRepos("acme"))[0]?.name, "refreshed");
    assert.equal(shell.calls.length, 1);
  });

  test("force bypasses a fresh cache and forwards the abort signal", async () => {
    const files = createFakeFiles({
      texts: { [`${cacheDir}/acme.json`]: cache("2026-01-01T11:30:00.000Z") },
    });
    const controller = new AbortController();
    const shell = createFakeShell([
      {
        match: (cmd) => cmd === "gh",
        result: (_cmd, _args, opts) => {
          assert.equal(opts?.signal, controller.signal);
          return { stdout: ghRepoJson("forced") };
        },
      },
    ]);
    const { github } = createAdapter(files, shell);

    assert.equal(
      (await github.listRepos("acme", { force: true, signal: controller.signal }))[0]?.name,
      "forced",
    );
  });

  test("returns stale data and warns when gh fails", async () => {
    const files = createFakeFiles({
      texts: { [`${cacheDir}/acme.json`]: cache("2025-12-01T00:00:00.000Z") },
    });
    const shell = createFakeShell([
      { match: (cmd) => cmd === "gh", result: { code: 1, stderr: "offline" } },
    ]);
    const logger = createNullLogger();
    const { github } = createAdapter(files, shell, logger);

    assert.deepEqual(await github.listRepos("acme"), [cachedRepo]);
    assert.equal(logger.entries.at(-1)?.level, "warn");
  });

  test("throws a helpful github error when gh fails without a cache", async () => {
    const shell = createFakeShell([
      { match: (cmd) => cmd === "gh", result: { code: 1, stderr: "not logged in" } },
    ]);
    const { github } = createAdapter(createFakeFiles(), shell);

    await assert.rejects(github.listRepos("acme"), (error: unknown) => {
      assert.ok(error instanceof SwarmError);
      assert.equal(error.code, "github");
      assert.match(error.message, /gh auth login/);
      return true;
    });
  });
});
