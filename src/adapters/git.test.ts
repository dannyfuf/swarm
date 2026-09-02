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
    await git.resetToRemote("/repos/repo", "main");
    await git.checkoutNewBranch("/work/repo", "feature/new", "origin/main");
    await git.checkoutTracking("/work/repo", "feature/x");
    assert.deepEqual(await git.remoteBranches("/repos/repo"), ["origin/main", "origin/feature/x"]);
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
        ["git", ["checkout", "-B", "main", "origin/main"]],
        ["git", ["reset", "--hard", "origin/main"]],
        ["git", ["clean", "-fd"]],
        ["git", ["checkout", "-b", "feature/new", "origin/main"]],
        ["git", ["checkout", "feature/x"]],
        ["git", ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]],
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
    ]);

    assert.equal(await createGit(shell, createNullLogger()).defaultBranch("/repo"), "trunk");
    assert.deepEqual(
      shell.calls.map(({ args }) => args),
      [
        ["symbolic-ref", "refs/remotes/origin/HEAD"],
        ["remote", "set-head", "origin", "--auto"],
        ["symbolic-ref", "refs/remotes/origin/HEAD"],
      ],
    );
  });

  test("falls back to main when present and master otherwise", async () => {
    const makeGit = (mainExists: boolean) => {
      const shell = createFakeShell([
        { match: (_cmd, args) => args[0] === "symbolic-ref", result: { code: 1 } },
        { match: (_cmd, args) => args[0] === "remote", result: { code: 1 } },
        {
          match: (_cmd, args) => args[0] === "show-ref",
          result: { code: mainExists ? 0 : 1 },
        },
      ]);
      return createGit(shell, createNullLogger());
    };

    assert.equal(await makeGit(true).defaultBranch("/repo"), "main");
    assert.equal(await makeGit(false).defaultBranch("/repo"), "master");
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
});
