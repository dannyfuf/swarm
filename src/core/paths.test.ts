import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  hotCopyPath,
  hotCopyPidPath,
  hotCopyStagingPath,
  installRoot,
  parseWorktreeId,
  repoId,
  repoPath,
  sessionName,
  slugify,
  swarmHome,
  worktreeId,
  worktreePath,
} from "./paths.ts";
import { validateBranch } from "./prs.ts";
import { defaultConfig } from "./types.ts";

describe("path helpers", () => {
  test("resolves SWARM_HOME before HOME", () => {
    assert.equal(swarmHome({ SWARM_HOME: "/tmp/custom", HOME: "/home/test" }), "/tmp/custom");
    assert.equal(swarmHome({ HOME: "/home/test" }), "/home/test/.swarm");
  });

  test("resolves the install root from the launcher override or running module", () => {
    assert.equal(
      installRoot({ SWARM_INSTALL_ROOT: "/opt/swarm" }, "file:///ignored/src/main.ts"),
      "/opt/swarm",
    );
    assert.equal(installRoot({}, "file:///opt/swarm/src/main.ts"), "/opt/swarm");
    assert.equal(installRoot({}, "file:///opt/swarm/dist/swarm.mjs"), "/opt/swarm");
  });

  test("slugifies branches with case, slashes, spaces, and punctuation", () => {
    assert.equal(slugify("feat/Payroll Fix"), "feat-payroll-fix");
    assert.equal(slugify("---Fix///UPPER...Case---"), "fix-upper...case");
    assert.equal(slugify(" spaces / everywhere "), "spaces-everywhere");
  });

  test("creates tmux-safe session names, including dotted repos", () => {
    assert.equal(sessionName("foo.js", "feat.thing:one"), "foo-js/feat-thing-one");
  });

  test("creates and parses identifiers", () => {
    const repository = repoId("bukhr", "payroll");
    const worktree = worktreeId(repository, "feat-fix");
    assert.equal(repository, "bukhr/payroll");
    assert.equal(worktree, "bukhr/payroll#feat-fix");
    assert.deepEqual(parseWorktreeId(worktree), {
      repoId: "bukhr/payroll",
      slug: "feat-fix",
    });
  });

  test("builds repo and worktree paths from config", () => {
    const config = defaultConfig("/home/test/.swarm");
    assert.equal(repoPath(config, "bukhr", "payroll"), "/home/test/.swarm/repos/bukhr/payroll");
    assert.equal(
      worktreePath(config, "bukhr", "payroll", "feat-fix"),
      "/home/test/.swarm/worktrees/bukhr/payroll/feat-fix",
    );
    assert.equal(
      hotCopyPath(config.worktreesDir, "bukhr/payroll"),
      "/home/test/.swarm/worktrees/bukhr/payroll/.hot",
    );
    assert.equal(
      hotCopyStagingPath(config.worktreesDir, "bukhr/payroll"),
      "/home/test/.swarm/worktrees/bukhr/payroll/.hot.staging",
    );
    assert.equal(
      hotCopyPath(config.worktreesDir, "bukhr/payroll", 2),
      "/home/test/.swarm/worktrees/bukhr/payroll/.hot.2",
    );
    assert.equal(
      hotCopyStagingPath(config.worktreesDir, "bukhr/payroll", 2),
      "/home/test/.swarm/worktrees/bukhr/payroll/.hot.2.staging",
    );
    assert.equal(
      hotCopyPidPath(config.worktreesDir, "bukhr/payroll"),
      "/home/test/.swarm/worktrees/bukhr/payroll/.hot.staging.pid",
    );
    assert.equal(
      hotCopyPidPath(config.worktreesDir, "bukhr/payroll", 2),
      "/home/test/.swarm/worktrees/bukhr/payroll/.hot.2.staging.pid",
    );
  });

  test("rejects branch slugs reserved for the hot-copy pool", () => {
    for (const branch of [".hot", ".hot.staging", " .hot-next"]) {
      assert.throws(
        () => validateBranch(branch),
        (error: unknown) =>
          error instanceof Error &&
          error.message === `Branch name is reserved for prepared copies: ${branch}`,
      );
    }
  });
});
