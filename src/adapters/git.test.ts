import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SwarmError } from "../core/errors.ts";
import { createFakeShell } from "../testing/fakeShell.ts";
import { createNullLogger } from "../testing/nullLogger.ts";
import { createGit } from "./git.ts";

describe("git adapter", () => {
  test("uses exact argv and launches clones detached with a log file", async () => {
    const shell = createFakeShell([
      {
        match: () => true,
        result: (_cmd, args) => {
          if (args[0] === "for-each-ref") {
            return { stdout: "origin\norigin/HEAD\norigin/main\norigin/feature/x\n" };
          }
          if (args[0] === "branch") return { stdout: "feature/x\n" };
          if (args[0] === "status") return { stdout: "?? new.txt\n" };
          if (args[0] === "rev-parse") return { stdout: "0123456789abcdef\n" };
          return {};
        },
      },
    ]);
    const git = createGit(shell, createNullLogger());

    const clonePid = await git.cloneDetached(
      "git@example.test:owner/repo.git",
      "/repos/repo",
      "/logs/clone.log",
    );
    await git.fetch("/repos/repo", { prune: true });
    await git.fetchRefs("/repos/repo", "origin", ["main", "feature/x"]);
    await git.resetToRemote("/repos/repo", "main");
    await git.checkoutNewBranch("/work/repo", "feature/new", "origin/main");
    await git.checkoutTracking("/work/repo", "feature/x");
    await git.fetchPullHead("/work/repo", 42, "pr/42");
    assert.deepEqual(await git.remoteBranches("/repos/repo"), ["origin/main", "origin/feature/x"]);
    assert.equal(await git.revision("/work/repo", "origin/main"), "0123456789abcdef");
    assert.equal(await git.currentBranch("/work/repo"), "feature/x");
    assert.equal(await git.isDirty("/work/repo"), true);

    assert.equal(clonePid, 4242);
    assert.deepEqual(shell.detachedCalls, [
      {
        cmd: "git",
        args: ["clone", "--progress", "git@example.test:owner/repo.git", "/repos/repo"],
        opts: { logPath: "/logs/clone.log" },
      },
    ]);
    assert.deepEqual(
      shell.calls.map(({ cmd, args }) => [cmd, args]),
      [
        ["git", ["clone", "--progress", "git@example.test:owner/repo.git", "/repos/repo"]],
        ["git", ["fetch", "--prune", "origin"]],
        ["git", ["fetch", "origin", "main", "feature/x"]],
        ["git", ["checkout", "-B", "main", "origin/main"]],
        ["git", ["reset", "--hard", "origin/main"]],
        ["git", ["clean", "-fd"]],
        ["git", ["checkout", "-b", "feature/new", "origin/main"]],
        ["git", ["checkout", "feature/x"]],
        ["git", ["fetch", "origin", "+refs/pull/42/head:refs/heads/pr/42"]],
        ["git", ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]],
        ["git", ["rev-parse", "--verify", "origin/main"]],
        ["git", ["branch", "--show-current"]],
        ["git", ["status", "--porcelain", "--untracked-files=normal"]],
      ],
    );
    assert.equal(
      shell.calls.slice(1).every((call) => call.opts?.cwd !== undefined),
      true,
    );
  });

  test("refreshes a missing origin HEAD before returning its branch", async () => {
    let symbolicCalls = 0;
    const shell = createFakeShell([
      {
        match: (_cmd, args) => args[0] === "symbolic-ref",
        result: () =>
          ++symbolicCalls === 1
            ? { code: 1, stderr: "not a symbolic ref" }
            : { stdout: "refs/remotes/origin/trunk\n" },
      },
      { match: (_cmd, args) => args[0] === "remote", result: {} },
      { match: (_cmd, args) => args[0] === "show-ref", result: {} },
    ]);

    assert.equal(await createGit(shell, createNullLogger()).defaultBranch("/repo"), "trunk");
    assert.deepEqual(
      shell.calls.map(({ args }) => args),
      [
        ["symbolic-ref", "refs/remotes/origin/HEAD"],
        ["remote", "set-head", "origin", "--auto"],
        ["symbolic-ref", "refs/remotes/origin/HEAD"],
        ["show-ref", "--verify", "--quiet", "refs/remotes/origin/trunk"],
      ],
    );
  });

  test("repairs a dangling origin HEAD before resolving the real default", async () => {
    let symbolicCalls = 0;
    const shell = createFakeShell([
      {
        match: (_cmd, args) => args[0] === "symbolic-ref",
        result: () => ({
          stdout:
            ++symbolicCalls === 1 ? "refs/remotes/origin/deleted\n" : "refs/remotes/origin/main\n",
        }),
      },
      { match: (_cmd, args) => args[0] === "remote", result: {} },
    ]);

    const branch = await createGit(shell, createNullLogger()).defaultBranch(
      "/repo",
      "deleted",
      undefined,
      ["origin/main"],
    );

    assert.equal(branch, "main");
    assert.ok(shell.calls.some(({ args }) => args.join(" ") === "remote set-head origin --auto"));
  });

  test("prefers a hinted remote branch, then main, then master", async () => {
    const makeGit = (existingBranches: string[]) => {
      const shell = createFakeShell([
        { match: (_cmd, args) => args[0] === "symbolic-ref", result: { code: 1 } },
        { match: (_cmd, args) => args[0] === "remote", result: { code: 1 } },
        {
          match: (_cmd, args) => args[0] === "show-ref",
          result: (_cmd, args) => ({
            code: existingBranches.includes(args.at(-1)?.replace("refs/remotes/origin/", "") ?? "")
              ? 0
              : 1,
          }),
        },
      ]);
      return createGit(shell, createNullLogger());
    };

    assert.equal(await makeGit(["trunk", "main"]).defaultBranch("/repo", "trunk"), "trunk");
    assert.equal(await makeGit(["main"]).defaultBranch("/repo", "trunk"), "main");
    assert.equal(await makeGit(["master"]).defaultBranch("/repo"), "master");
  });

  test("uses the hint for an empty remote, then an unborn local HEAD, then main", async () => {
    const makeGit = (localHead?: string) => {
      const shell = createFakeShell([
        {
          match: (_cmd, args) => args[0] === "symbolic-ref",
          result: (_cmd, args) =>
            args[1] === "--short" && localHead ? { stdout: `${localHead}\n` } : { code: 1 },
        },
        { match: (_cmd, args) => args[0] === "remote", result: { code: 1 } },
        { match: (_cmd, args) => args[0] === "show-ref", result: { code: 1 } },
        { match: (_cmd, args) => args[0] === "for-each-ref", result: { stdout: "" } },
      ]);
      return { git: createGit(shell, createNullLogger()), shell };
    };

    const hinted = makeGit("legacy");
    assert.equal(await hinted.git.defaultBranch("/repo", "main"), "main");
    assert.equal(
      hinted.shell.calls.some(({ args }) => args[0] === "symbolic-ref" && args[1] === "--short"),
      false,
    );
    assert.equal(await makeGit("develop").git.defaultBranch("/repo"), "develop");
    assert.equal(await makeGit().git.defaultBranch("/repo"), "main");
  });

  test("turns command failures into git errors containing stderr", async () => {
    const shell = createFakeShell([
      { match: () => true, result: { code: 128, stderr: "fatal: repository missing\n" } },
    ]);
    await assert.rejects(
      createGit(shell, createNullLogger()).fetch("/repo"),
      (error: unknown) =>
        error instanceof SwarmError &&
        error.code === "git" &&
        error.message.includes("fatal: repository missing"),
    );
  });

  test("validates pull request fetch inputs before invoking git", async () => {
    const shell = createFakeShell();
    const git = createGit(shell, createNullLogger());
    await assert.rejects(
      git.fetchPullHead("/repo", 0, "pr/0"),
      (error) => error instanceof SwarmError && error.code === "validation",
    );
    await assert.rejects(
      git.fetchPullHead("/repo", 1, "bad branch"),
      (error) => error instanceof SwarmError && error.code === "validation",
    );
    assert.equal(shell.calls.length, 0);
  });
});
