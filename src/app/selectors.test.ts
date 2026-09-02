import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AppState } from "../core/app.ts";
import type { PrRepoSlice, PullRequest } from "../core/types.ts";
import { makeAppState, pullRequest, worktrees } from "../testing/fixtures.ts";
import {
  prErrorsInScope,
  prHints,
  prLoadingInScope,
  prsInScope,
  prWorktree,
  reviewCount,
  selectedPr,
  worktreePr,
} from "./selectors.ts";
import { createStore } from "./store.ts";

function slice(prs: PullRequest[], overrides: Partial<PrRepoSlice> = {}): PrRepoSlice {
  return { prs, fetchedAt: "2026-02-12T00:00:00.000Z", loading: false, ...overrides };
}

function state(overrides: Partial<AppState> = {}): AppState {
  return createStore(makeAppState(overrides)).getState();
}

describe("pull request selectors", () => {
  const payroll = pullRequest({
    number: 10,
    title: "Payroll export",
    headRefName: "feat/payroll-fix",
    updatedAt: "2026-02-10T00:00:00.000Z",
  });
  const platform = pullRequest({
    repoId: "bukhr/platform",
    number: 20,
    title: "API cleanup",
    author: "reviewer",
    updatedAt: "2026-02-12T00:00:00.000Z",
  });

  test("scopes, fuzzy filters, and deterministically sorts PRs", () => {
    const current = state({
      prs: {
        mine: {
          "bukhr/payroll": slice([payroll]),
          "bukhr/platform": slice([platform]),
          "dannyfuf/dotfiles": slice([pullRequest({ repoId: "dannyfuf/dotfiles", number: 30 })]),
        },
        review: {},
      },
    });
    assert.deepEqual(
      prsInScope(current, "mine").map(({ number }) => number),
      [20, 10],
    );
    assert.deepEqual(
      prsInScope({ ...current, prFilter: "#10" }, "mine").map(({ number }) => number),
      [10],
    );
    assert.deepEqual(
      prsInScope({ ...current, prScope: { kind: "repo", repoId: "bukhr/payroll" } }, "mine"),
      [payroll],
    );
  });

  test("reports scoped loading/errors and keeps authored PRs out of review", () => {
    const current = state({
      prs: {
        mine: { "bukhr/payroll": slice([payroll]) },
        review: {
          "bukhr/payroll": slice([payroll], { error: "offline", loading: true }),
          "bukhr/platform": slice([platform]),
        },
      },
    });
    assert.deepEqual(prsInScope(current, "review"), [platform]);
    assert.equal(reviewCount(current), 1);
    assert.equal(prLoadingInScope(current, "review"), true);
    assert.deepEqual(prErrorsInScope(current, "review"), [
      { repoId: "bukhr/payroll", error: "offline" },
    ]);
  });

  test("selects rows and links PRs in both directions", () => {
    const matching = worktrees[1];
    assert.ok(matching);
    const current = state({
      screen: "prs",
      prs: {
        mine: { "bukhr/payroll": slice([payroll]) },
        review: {},
      },
    });
    assert.equal(selectedPr(current)?.number, payroll.number);
    assert.equal(prWorktree(current, payroll)?.id, matching.id);
    assert.equal(worktreePr(current, matching)?.number, payroll.number);
    assert.equal(prHints(current)[0]?.label, "open");
    assert.deepEqual(
      prHints(current).map(({ key }) => key),
      ["Enter", "O", "b", "y", "/", "r", "Tab", "Esc", "?"],
    );
    assert.equal(
      prHints({
        ...current,
        prs: {
          ...current.prs,
          mine: { "bukhr/payroll": slice([pullRequest({ number: 999 })]) },
        },
      })[0]?.label,
      "create worktree",
    );
  });

  test("both open hints promise a creation when the PR has no worktree yet", () => {
    const linked = state({
      screen: "prs",
      prs: { mine: { "bukhr/payroll": slice([payroll]) }, review: {} },
    });
    assert.deepEqual(
      prHints(linked)
        .slice(0, 2)
        .map(({ label }) => label),
      ["open", "open, keep previous"],
    );

    const loose = {
      ...linked,
      prs: { ...linked.prs, mine: { "bukhr/payroll": slice([pullRequest({ number: 999 })]) } },
    };
    assert.deepEqual(
      prHints(loose)
        .slice(0, 2)
        .map(({ label }) => label),
      ["create worktree", "create, keep previous"],
    );
  });

  test("omits row actions when the active PR list is empty", () => {
    assert.deepEqual(
      prHints(state()).map(({ key }) => key),
      ["/", "r", "Tab", "Esc", "?"],
    );
  });
});
