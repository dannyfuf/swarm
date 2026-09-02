import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pullRequest, worktrees } from "../testing/fixtures.ts";
import { matchPrWorktree, prBaseRef, prLocalBranch, prState, prStateLabel } from "./prs.ts";
import { PullRequestSchema } from "./types.ts";

describe("pull request helpers", () => {
  test("applies the state priority table and labels", () => {
    const cases = [
      [pullRequest({ isDraft: true, checks: "fail" }), "draft", "draft"],
      [pullRequest({ checks: "fail", reviewDecision: "changes_requested" }), "ci_fail", "ci ✗"],
      [pullRequest({ checks: "pass", reviewDecision: "changes_requested" }), "changes", "changes"],
      [pullRequest({ checks: "pending", reviewDecision: "approved" }), "ci_pending", "ci …"],
      [pullRequest({ checks: "pass", reviewDecision: "approved" }), "approved", "approved"],
      [pullRequest({ checks: "none", reviewDecision: "none" }), "review", "review"],
    ] as const;

    for (const [pr, state, label] of cases) {
      assert.equal(prState(pr), state);
      assert.equal(prStateLabel(state), label);
    }
  });

  test("matches same-repo branches and fork pull refs without cross-repo false positives", () => {
    const branchWorktree = worktrees[1];
    assert.ok(branchWorktree);
    assert.equal(
      matchPrWorktree(
        pullRequest({ repoId: branchWorktree.repoId, headRefName: branchWorktree.branch }),
        worktrees,
      )?.id,
      branchWorktree.id,
    );
    assert.equal(
      matchPrWorktree(
        pullRequest({ repoId: "bukhr/platform", headRefName: branchWorktree.branch }),
        worktrees,
      ),
      undefined,
    );
    assert.equal(
      matchPrWorktree(
        pullRequest({
          repoId: branchWorktree.repoId,
          number: 99,
          headRefName: branchWorktree.branch,
          isCrossRepository: true,
        }),
        worktrees,
      ),
      undefined,
    );
    const forkWorktree = { ...branchWorktree, baseRef: "pull/99/head" };
    assert.equal(
      matchPrWorktree(
        pullRequest({ repoId: forkWorktree.repoId, number: 99, isCrossRepository: true }),
        [forkWorktree],
      )?.id,
      forkWorktree.id,
    );
  });

  test("derives local branches and persisted base refs", () => {
    const local = pullRequest({ headRefName: "feature/local" });
    const fork = pullRequest({ number: 17, isCrossRepository: true });
    assert.equal(prLocalBranch(local), "feature/local");
    assert.equal(prBaseRef(local), undefined);
    assert.equal(prLocalBranch(fork), "pr/17");
    assert.equal(prBaseRef(fork), "pull/17/head");
  });

  test("accepts only exact GitHub pull URLs whose number matches the PR", () => {
    assert.equal(PullRequestSchema.parse(pullRequest()).number, 42);

    for (const url of [
      "https://evil.example/phish",
      "javascript:alert(1)",
      "file:///tmp/pr",
      "http://github.com/bukhr/payroll/pull/42",
      "https://github.com/bukhr/payroll/pull/41",
      "https://github.com/bukhr/payroll/issues/42",
      "https://github.com/bukhr/payroll/pull/42?diff=split",
    ]) {
      assert.equal(PullRequestSchema.safeParse(pullRequest({ url })).success, false, url);
    }
  });
});
