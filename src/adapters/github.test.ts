import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import { SwarmError } from "../core/errors.ts";
import type { RemoteRepo } from "../core/types.ts";
import { createFakeFiles } from "../testing/fakeFiles.ts";
import { createFakeShell } from "../testing/fakeShell.ts";
import { createFixedClock } from "../testing/fixedClock.ts";
import { pullRequest } from "../testing/fixtures.ts";
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

function ghPr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const number = typeof overrides.number === "number" ? overrides.number : 42;
  return {
    number,
    title: "Improve exports",
    url: `https://github.com/acme/app/pull/${number}`,
    author: { login: "octocat" },
    headRefName: "feat/exports",
    baseRefName: "main",
    isDraft: false,
    isCrossRepository: false,
    headRepository: { name: "app", nameWithOwner: "acme/app" },
    headRepositoryOwner: { login: "acme" },
    reviewDecision: "REVIEW_REQUIRED",
    statusCheckRollup: [],
    additions: 10,
    deletions: 2,
    labels: [{ name: "feature" }],
    updatedAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  };
}

function prCache(fetchedAt: string) {
  return JSON.stringify({
    fetchedAt,
    prs: [pullRequest({ repoId: "acme/app", url: "https://github.com/acme/app/pull/42" })],
  });
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

  test("uses exact pull request argv for both tabs", async () => {
    const shell = createFakeShell([{ match: (cmd) => cmd === "gh", result: { stdout: "[]" } }]);
    const { github } = createAdapter(createFakeFiles(), shell);

    await github.listPullRequests({ owner: "acme", name: "app" }, "mine");
    await github.listPullRequests({ owner: "acme", name: "app" }, "review");

    const base = [
      "pr",
      "list",
      "--repo",
      "acme/app",
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,url,author,headRefName,baseRefName,isDraft,isCrossRepository,headRepository,headRepositoryOwner,reviewDecision,statusCheckRollup,additions,deletions,labels,updatedAt",
    ];
    assert.deepEqual(shell.calls[0]?.args, [...base, "--author", "@me"]);
    assert.deepEqual(shell.calls[1]?.args, [...base, "--search", "review-requested:@me"]);
  });

  test("maps review decisions, fork metadata, labels, and check rollups", async () => {
    const shell = createFakeShell([
      {
        match: (cmd) => cmd === "gh",
        result: {
          stdout: JSON.stringify([
            ghPr({
              number: 1,
              reviewDecision: "APPROVED",
              statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }],
            }),
            ghPr({
              number: 2,
              reviewDecision: "CHANGES_REQUESTED",
              statusCheckRollup: [{ conclusion: "FAILURE", status: "COMPLETED" }],
            }),
            ghPr({
              number: 3,
              reviewDecision: "",
              statusCheckRollup: [{ conclusion: null, status: "IN_PROGRESS" }],
            }),
            ghPr({
              number: 4,
              isCrossRepository: true,
              headRepository: { name: "fork" },
              headRepositoryOwner: { login: "contributor" },
              reviewDecision: null,
            }),
          ]),
        },
      },
    ]);
    const { github } = createAdapter(createFakeFiles(), shell);

    const result = await github.listPullRequests({ owner: "acme", name: "app" }, "mine");

    assert.deepEqual(
      result.prs.map(({ number, reviewDecision, checks }) => ({
        number,
        reviewDecision,
        checks,
      })),
      [
        { number: 1, reviewDecision: "approved", checks: "pass" },
        { number: 2, reviewDecision: "changes_requested", checks: "fail" },
        { number: 3, reviewDecision: "none", checks: "pending" },
        { number: 4, reviewDecision: "none", checks: "none" },
      ],
    );
    assert.equal(result.prs[3]?.headRepo, "contributor/fork");
    assert.deepEqual(result.prs[0]?.labels, ["feature"]);
  });

  test("maps mixed CheckRun and StatusContext rollups", async () => {
    const cases = [
      {
        rollup: [
          { __typename: "CheckRun", conclusion: "SUCCESS", status: "COMPLETED" },
          { __typename: "StatusContext", state: "SUCCESS" },
        ],
        expected: "pass",
      },
      {
        rollup: [
          { __typename: "CheckRun", conclusion: "STARTUP_FAILURE", status: "COMPLETED" },
          { __typename: "StatusContext", state: "PENDING" },
        ],
        expected: "fail",
      },
      {
        rollup: [
          { __typename: "CheckRun", conclusion: "STALE", status: "COMPLETED" },
          { __typename: "StatusContext", state: "SUCCESS" },
        ],
        expected: "pending",
      },
    ] as const;
    const shell = createFakeShell([
      {
        match: (cmd) => cmd === "gh",
        result: {
          stdout: JSON.stringify(
            cases.map(({ rollup }, index) =>
              ghPr({ number: index + 1, statusCheckRollup: rollup }),
            ),
          ),
        },
      },
    ]);
    const { github } = createAdapter(createFakeFiles(), shell);

    const result = await github.listPullRequests({ owner: "acme", name: "app" }, "mine");

    assert.deepEqual(
      result.prs.map(({ checks }) => checks),
      cases.map(({ expected }) => expected),
    );
  });

  test("maps a ghost author and deleted fork metadata without losing the PR", async () => {
    const shell = createFakeShell([
      {
        match: (cmd) => cmd === "gh",
        result: {
          stdout: JSON.stringify([
            ghPr({
              author: null,
              isCrossRepository: true,
              headRepository: null,
              headRepositoryOwner: null,
            }),
          ]),
        },
      },
    ]);
    const { github } = createAdapter(createFakeFiles(), shell);

    const result = await github.listPullRequests({ owner: "acme", name: "app" }, "review");

    assert.equal(result.prs[0]?.author, "ghost");
    assert.equal(result.prs[0]?.headRepo, undefined);
    assert.equal(result.prs[0]?.isCrossRepository, true);
  });

  test("validates pull request JSON", async () => {
    const shell = createFakeShell([
      { match: (cmd) => cmd === "gh", result: { stdout: JSON.stringify([ghPr({ number: -1 })]) } },
    ]);
    const { github } = createAdapter(createFakeFiles(), shell);

    await assert.rejects(
      github.listPullRequests({ owner: "acme", name: "app" }, "mine"),
      (error: unknown) =>
        error instanceof SwarmError && /invalid pull request data/.test(error.message),
    );
  });

  test("reads validated PR caches with freshness separate from network refresh", async () => {
    const path = `${cacheDir}/prs/acme/app/mine.json`;
    const files = createFakeFiles({
      texts: { [path]: prCache("2026-01-01T11:59:30.000Z") },
    });
    const shell = createFakeShell([
      {
        match: (cmd) => cmd === "gh",
        result: { stdout: JSON.stringify([ghPr({ number: 88 })]) },
      },
    ]);
    const { github } = createAdapter(files, shell);

    const cached = await github.readCachedPullRequests({ owner: "acme", name: "app" }, "mine", {
      ttlSeconds: 90,
    });
    assert.ok(cached);
    assert.equal(cached.prs[0]?.number, 42);
    assert.equal(cached.stale, false);
    assert.equal(shell.calls.length, 0);
    assert.equal(
      (
        await github.readCachedPullRequests({ owner: "acme", name: "app" }, "mine", {
          ttlSeconds: 10,
        })
      )?.stale,
      true,
    );

    const refreshed = await github.listPullRequests({ owner: "acme", name: "app" }, "mine");
    assert.equal(refreshed.prs[0]?.number, 88);
    const rewritten = await github.readCachedPullRequests({ owner: "acme", name: "app" }, "mine", {
      ttlSeconds: 90,
    });
    assert.equal(rewritten?.prs[0]?.number, 88);
    assert.equal(rewritten?.stale, false);
  });

  test("rejects invalid PR URLs from gh and ignores them in disk caches", async () => {
    const path = `${cacheDir}/prs/acme/app/mine.json`;
    const files = createFakeFiles({
      texts: {
        [path]: JSON.stringify({
          fetchedAt: now,
          prs: [pullRequest({ repoId: "acme/app", url: "https://evil.example/phish" })],
        }),
      },
    });
    const shell = createFakeShell([
      {
        match: (cmd) => cmd === "gh",
        result: { stdout: JSON.stringify([ghPr({ url: "https://evil.example/phish" })]) },
      },
    ]);
    const logger = createNullLogger();
    const { github } = createAdapter(files, shell, logger);

    assert.equal(
      await github.readCachedPullRequests({ owner: "acme", name: "app" }, "mine"),
      undefined,
    );
    assert.equal(logger.entries.at(-1)?.level, "warn");
    await assert.rejects(
      github.listPullRequests({ owner: "acme", name: "app" }, "mine"),
      (error: unknown) =>
        error instanceof SwarmError && /invalid pull request data/.test(error.message),
    );
  });
});
