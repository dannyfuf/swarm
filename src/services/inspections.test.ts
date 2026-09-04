import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { StatusService } from "../core/services.ts";
import type { WorktreeInspection, WorktreeStatus } from "../core/types.ts";
import { createFakeFiles } from "../testing/fakeFiles.ts";
import { createFakeGit } from "../testing/fakeGit.ts";
import { createFakeGithub } from "../testing/fakeGithub.ts";
import { createFixedClock } from "../testing/fixedClock.ts";
import { makeState, repos, worktrees } from "../testing/fixtures.ts";
import { createMemoryState } from "../testing/memoryState.ts";
import {
  createInspectionService,
  deleteRefusalReason,
  pruneIneligibilityReason,
} from "./inspections.ts";

function statusService(statuses: WorktreeStatus[] = []): StatusService {
  return {
    async snapshot() {
      return new Map(statuses.map((status) => [status.worktreeId, status]));
    },
  };
}

describe("InspectionService", () => {
  test("computes Git, pull request, fetch, and tmux facts with injected ports", async () => {
    const first = worktrees[1];
    const second = worktrees[2];
    const repo = repos[0];
    assert.ok(first && second && repo);
    const git = createFakeGit({
      upstreams: {
        [first.path]: { ref: "origin/feat/payroll-fix", gone: false },
        [second.path]: { ref: "origin/fix/1234", gone: true },
      },
      aheadBehind: { [first.path]: { ahead: 3, behind: 2 } },
      commitCounts: { [first.path]: 0, [second.path]: 4 },
      existingRefs: {
        [first.path]: ["refs/remotes/origin/release", "refs/remotes/origin/feat/payroll-fix"],
        [second.path]: ["refs/remotes/origin/main"],
      },
      dirtyPaths: [second.path],
      ancestors: {
        [JSON.stringify([first.path, "HEAD", "origin/release"])]: true,
        [JSON.stringify([second.path, "HEAD", "origin/main"])]: false,
      },
    });
    const github = createFakeGithub({
      inspectionPrsByRepoBranch: {
        [`${repo.id}:${first.branch}`]: {
          number: 91,
          state: "MERGED",
          url: "https://github.com/bukhr/payroll/pull/91",
          baseRefName: "release",
          headRefOid: "1".repeat(40),
        },
      },
    });
    const service = createInspectionService({
      state: createMemoryState(makeState({ worktrees: [first, second] })),
      files: createFakeFiles({ paths: [first.path, second.path] }),
      git,
      github,
      status: statusService([
        {
          worktreeId: first.id,
          session: "attached",
          windows: [],
          running: ["claude"],
        },
      ]),
      clock: createFixedClock("2026-09-04T12:00:00.000Z"),
    });

    const inspected = await service.inspect({ fetch: true });

    assert.equal(
      git.calls.filter(({ method }) => method === "fetch").length,
      1,
      "fetches once for both worktrees in the same repo",
    );
    assert.deepEqual(inspected[0], {
      worktreeId: first.id,
      repoId: first.repoId,
      host: "local",
      path: first.path,
      branch: first.branch,
      baseRef: first.baseRef,
      head: "1".repeat(40),
      targetBranch: "release",
      upstream: "origin/feat/payroll-fix",
      ahead: 3,
      behind: 2,
      upstreamGone: false,
      dirty: false,
      mergedIntoTarget: true,
      uniqueCommits: 0,
      published: true,
      merged: true,
      pr: {
        number: 91,
        state: "MERGED",
        url: "https://github.com/bukhr/payroll/pull/91",
        baseRefName: "release",
        headRefOid: "1".repeat(40),
      },
      session: "attached",
      running: ["claude"],
      inspectedAt: "2026-09-04T12:00:00.000Z",
      warnings: [],
      error: null,
    });
    assert.equal(inspected[1]?.upstreamGone, true);
    assert.equal(inspected[1]?.ahead, null);
    assert.equal(inspected[1]?.dirty, true);
    assert.equal(inspected[1]?.uniqueCommits, 4);
    assert.equal(inspected[1]?.published, true);
    assert.equal(inspected[1]?.merged, false);
    assert.deepEqual(inspected[1]?.warnings, ["upstream gone"]);
  });

  test("returns per-worktree errors for missing paths and unreachable remote hosts", async () => {
    const local = worktrees[0];
    const source = worktrees[1];
    assert.ok(local && source);
    const remote = { ...source, host: "devbox" };
    const remoteHosts = {
      async inspect() {
        throw new Error("devbox unreachable: offline");
      },
    };
    const service = createInspectionService({
      state: createMemoryState(makeState({ worktrees: [local, remote] })),
      files: createFakeFiles(),
      git: createFakeGit(),
      github: createFakeGithub(),
      status: statusService(),
      clock: createFixedClock(),
      remoteHosts,
    });

    const inspected = await service.inspect();

    assert.match(inspected[0]?.error ?? "", /directory is missing/);
    assert.equal(inspected[1]?.host, "devbox");
    assert.equal(inspected[1]?.error, "devbox unreachable: offline");
  });

  test("derives merged from publication plus ancestry or a merged pull request", async () => {
    const fresh = worktrees[1];
    const pushed = worktrees[2];
    const squashMerged = worktrees[3];
    assert.ok(fresh && pushed && squashMerged);
    const open = {
      ...fresh,
      id: "bukhr/payroll#open",
      slug: "open",
      branch: "feat/open",
      path: `${fresh.path}-open`,
    };
    const selected = [fresh, pushed, squashMerged, open];
    const git = createFakeGit({
      upstreams: Object.fromEntries(
        selected.map((worktree) => [worktree.path, { ref: "origin/main", gone: false }]),
      ),
      commitCounts: {
        [fresh.path]: 0,
        [pushed.path]: 0,
        [squashMerged.path]: 3,
        [open.path]: 2,
      },
      existingRefs: {
        [fresh.path]: ["refs/remotes/origin/main"],
        [pushed.path]: ["refs/remotes/origin/main", `refs/remotes/origin/${pushed.branch}`],
        [squashMerged.path]: [
          "refs/remotes/origin/main",
          `refs/remotes/origin/${squashMerged.branch}`,
        ],
        [open.path]: ["refs/remotes/origin/main", `refs/remotes/origin/${open.branch}`],
      },
      ancestors: {
        [JSON.stringify([fresh.path, "HEAD", "origin/main"])]: true,
        [JSON.stringify([pushed.path, "HEAD", "origin/main"])]: true,
      },
    });
    const github = createFakeGithub({
      inspectionPrsByRepoBranch: {
        [`${squashMerged.repoId}:${squashMerged.branch}`]: {
          number: 10,
          state: "MERGED",
          url: "https://github.com/bukhr/platform/pull/10",
          baseRefName: "main",
          headRefOid: "1".repeat(40),
        },
        [`${open.repoId}:${open.branch}`]: {
          number: 11,
          state: "OPEN",
          url: "https://github.com/bukhr/payroll/pull/11",
          baseRefName: "main",
          headRefOid: "1".repeat(40),
        },
      },
    });
    const service = createInspectionService({
      state: createMemoryState(makeState({ worktrees: selected })),
      files: createFakeFiles({ paths: selected.map(({ path }) => path) }),
      git,
      github,
      status: statusService(),
      clock: createFixedClock(),
    });

    const inspected = new Map(
      (await service.inspect()).map((inspection) => [inspection.worktreeId, inspection]),
    );

    assert.deepEqual(
      [fresh, pushed, squashMerged, open].map(({ id }) => {
        const facts = inspected.get(id);
        return (
          facts && {
            mergedIntoTarget: facts.mergedIntoTarget,
            uniqueCommits: facts.uniqueCommits,
            published: facts.published,
            merged: facts.merged,
          }
        );
      }),
      [
        { mergedIntoTarget: true, uniqueCommits: 0, published: false, merged: false },
        { mergedIntoTarget: true, uniqueCommits: 0, published: true, merged: true },
        { mergedIntoTarget: false, uniqueCommits: 3, published: true, merged: true },
        { mergedIntoTarget: false, uniqueCommits: 2, published: true, merged: false },
      ],
    );
  });

  test("accepts a merged pull request only when its head contains the local HEAD", async () => {
    const source = worktrees[1];
    assert.ok(source);
    const matching = {
      ...source,
      id: "bukhr/payroll#matching",
      slug: "matching",
      branch: "matching",
      path: `${source.path}-matching`,
    };
    const newer = {
      ...source,
      id: "bukhr/payroll#newer",
      slug: "newer",
      branch: "newer",
      path: `${source.path}-newer`,
    };
    const missing = {
      ...source,
      id: "bukhr/payroll#missing-pr-head",
      slug: "missing-pr-head",
      branch: "missing-pr-head",
      path: `${source.path}-missing-pr-head`,
    };
    const matchingHead = "a".repeat(40);
    const mergedHead = "b".repeat(40);
    const newerHead = "c".repeat(40);
    const missingLocalHead = "d".repeat(40);
    const missingPrHead = "e".repeat(40);
    const selected = [matching, newer, missing];
    const git = createFakeGit({
      revisions: {
        [matching.path]: { HEAD: matchingHead },
        [newer.path]: { HEAD: newerHead },
        [missing.path]: { HEAD: missingLocalHead },
      },
      upstreams: Object.fromEntries(
        selected.map((worktree) => [
          worktree.path,
          { ref: `origin/${worktree.branch}`, gone: false },
        ]),
      ),
      commitCounts: Object.fromEntries(selected.map((worktree) => [worktree.path, 2])),
      existingRefs: Object.fromEntries(
        selected.map((worktree) => [
          worktree.path,
          ["refs/remotes/origin/main", `refs/remotes/origin/${worktree.branch}`],
        ]),
      ),
    });
    const isAncestor = git.isAncestor.bind(git);
    git.isAncestor = async (path, ancestor, descendant) => {
      if (descendant === missingPrHead) throw new Error("bad object");
      return isAncestor(path, ancestor, descendant);
    };
    const github = createFakeGithub({
      inspectionPrsByRepoBranch: {
        [`${matching.repoId}:${matching.branch}`]: {
          number: 20,
          state: "MERGED",
          url: "https://github.com/bukhr/payroll/pull/20",
          baseRefName: "main",
          headRefOid: matchingHead,
        },
        [`${newer.repoId}:${newer.branch}`]: {
          number: 21,
          state: "MERGED",
          url: "https://github.com/bukhr/payroll/pull/21",
          baseRefName: "main",
          headRefOid: mergedHead,
        },
        [`${missing.repoId}:${missing.branch}`]: {
          number: 22,
          state: "MERGED",
          url: "https://github.com/bukhr/payroll/pull/22",
          baseRefName: "main",
          headRefOid: missingPrHead,
        },
      },
    });
    const service = createInspectionService({
      state: createMemoryState(makeState({ worktrees: selected })),
      files: createFakeFiles({ paths: selected.map(({ path }) => path) }),
      git,
      github,
      status: statusService(),
      clock: createFixedClock(),
    });

    const byId = new Map(
      (await service.inspect()).map((inspection) => [inspection.worktreeId, inspection]),
    );
    const matchingInspection = byId.get(matching.id);
    const newerInspection = byId.get(newer.id);
    const missingInspection = byId.get(missing.id);
    assert.equal(matchingInspection?.merged, true);
    assert.equal(newerInspection?.merged, false);
    assert.match(
      deleteRefusalReason(newerInspection as WorktreeInspection) ?? "",
      /2 unique commits/,
    );
    assert.match(
      pruneIneligibilityReason(newerInspection as WorktreeInspection) ?? "",
      /not merged/,
    );
    assert.equal(missingInspection?.merged, false);
    assert.ok(missingInspection?.warnings.includes("pull request head comparison failed"));
  });

  test("keeps fetch and GitHub failures as warnings", async () => {
    const worktree = worktrees[0];
    assert.ok(worktree);
    const git = createFakeGit({
      existingRefs: {
        [worktree.path]: ["refs/remotes/origin/main"],
      },
    });
    git.fetch = async () => {
      throw new Error("offline");
    };
    const service = createInspectionService({
      state: createMemoryState(makeState({ worktrees: [worktree] })),
      files: createFakeFiles({ paths: [worktree.path] }),
      git,
      github: createFakeGithub({ prErrors: { [worktree.repoId]: new Error("no gh auth") } }),
      status: statusService(),
      clock: createFixedClock(),
    });

    const [inspected] = await service.inspect({ fetch: true });

    assert.deepEqual(inspected?.warnings, ["fetch failed", "gh unavailable", "no upstream"]);
    assert.equal(inspected?.error, null);
  });

  test("keeps unique unpublished work safe when GitHub is unavailable", async () => {
    const worktree = worktrees[1];
    assert.ok(worktree);
    const git = createFakeGit({
      upstreams: { [worktree.path]: { ref: "origin/main", gone: false } },
      commitCounts: { [worktree.path]: 2 },
      existingRefs: {
        [worktree.path]: ["refs/remotes/origin/main"],
      },
    });
    const service = createInspectionService({
      state: createMemoryState(makeState({ worktrees: [worktree] })),
      files: createFakeFiles({ paths: [worktree.path] }),
      git,
      github: createFakeGithub({ prErrors: { [worktree.repoId]: new Error("no gh auth") } }),
      status: statusService(),
      clock: createFixedClock(),
    });

    const [inspected] = await service.inspect();

    assert.ok(inspected);
    assert.equal(inspected.uniqueCommits, 2);
    assert.equal(inspected.published, false);
    assert.equal(inspected.merged, false);
    assert.ok(inspected.warnings.includes("gh unavailable"));
    assert.match(deleteRefusalReason(inspected) ?? "", /2 unique commits/);
    assert.match(pruneIneligibilityReason(inspected) ?? "", /not merged/);
  });

  test("uses null unique commits when the target ref is missing", async () => {
    const worktree = worktrees[1];
    assert.ok(worktree);
    const service = createInspectionService({
      state: createMemoryState(makeState({ worktrees: [worktree] })),
      files: createFakeFiles({ paths: [worktree.path] }),
      git: createFakeGit(),
      github: createFakeGithub(),
      status: statusService([
        { worktreeId: worktree.id, session: "none", windows: [], running: [] },
      ]),
      clock: createFixedClock(),
    });

    const [inspected] = await service.inspect();

    assert.equal(inspected?.uniqueCommits, null);
    assert.equal(inspected?.mergedIntoTarget, false);
    assert.ok(inspected?.warnings.includes("target ref missing"));
    assert.equal(
      deleteRefusalReason(inspected as WorktreeInspection),
      "cannot determine unique commits",
    );
    assert.equal(
      pruneIneligibilityReason(inspected as WorktreeInspection),
      "cannot determine unique commits",
    );
  });

  test("fails closed when the unique commit count cannot be computed", async () => {
    const worktree = worktrees[1];
    assert.ok(worktree);
    const git = createFakeGit({
      existingRefs: { [worktree.path]: ["refs/remotes/origin/main"] },
    });
    git.commitCount = async () => {
      throw new Error("rev-list failed");
    };
    const service = createInspectionService({
      state: createMemoryState(makeState({ worktrees: [worktree] })),
      files: createFakeFiles({ paths: [worktree.path] }),
      git,
      github: createFakeGithub(),
      status: statusService([
        { worktreeId: worktree.id, session: "none", windows: [], running: [] },
      ]),
      clock: createFixedClock(),
    });

    const [inspected] = await service.inspect();

    assert.ok(inspected);
    assert.equal(inspected.uniqueCommits, null);
    assert.ok(inspected.warnings.includes("unique commit count unavailable"));
    assert.equal(deleteRefusalReason(inspected), "cannot determine unique commits");
    assert.equal(pruneIneligibilityReason(inspected), "cannot determine unique commits");
  });
});

function inspection(overrides: Partial<WorktreeInspection> = {}): WorktreeInspection {
  const worktree = worktrees[0];
  assert.ok(worktree);
  return {
    worktreeId: worktree.id,
    repoId: worktree.repoId,
    host: "local",
    path: worktree.path,
    branch: worktree.branch,
    baseRef: worktree.baseRef,
    head: "1".repeat(40),
    targetBranch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    upstreamGone: false,
    dirty: false,
    mergedIntoTarget: true,
    uniqueCommits: 0,
    published: true,
    merged: true,
    pr: null,
    session: "none",
    running: [],
    inspectedAt: "2026-09-04T00:00:00.000Z",
    warnings: [],
    error: null,
    ...overrides,
  };
}

test("delete and prune distinguish fresh, published, and pull-request merges", () => {
  const fresh = inspection({
    mergedIntoTarget: true,
    uniqueCommits: 0,
    published: false,
    merged: false,
  });
  assert.equal(deleteRefusalReason(fresh), undefined);
  assert.match(pruneIneligibilityReason(fresh) ?? "", /not merged/);

  const pushedAncestor = inspection({ published: true, mergedIntoTarget: true, merged: true });
  assert.equal(deleteRefusalReason(pushedAncestor), undefined);
  assert.equal(pruneIneligibilityReason(pushedAncestor), undefined);

  const mergedPullRequest = inspection({
    uniqueCommits: 3,
    mergedIntoTarget: false,
    merged: true,
    pr: {
      number: 1,
      state: "MERGED",
      url: "https://github.com/bukhr/payroll/pull/1",
      baseRefName: "main",
      headRefOid: "1".repeat(40),
    },
  });
  assert.equal(deleteRefusalReason(mergedPullRequest), undefined);
  assert.equal(pruneIneligibilityReason(mergedPullRequest), undefined);

  const openPullRequest = inspection({
    uniqueCommits: 3,
    mergedIntoTarget: false,
    merged: false,
    pr: {
      number: 2,
      state: "OPEN",
      url: "https://github.com/bukhr/payroll/pull/2",
      baseRefName: "main",
      headRefOid: "1".repeat(40),
    },
  });
  assert.match(deleteRefusalReason(openPullRequest) ?? "", /3 unique commits/);
  assert.match(pruneIneligibilityReason(openPullRequest) ?? "", /not merged/);
});

test("safety reasons list every applicable blocker", () => {
  const blocked = inspection({
    dirty: true,
    uniqueCommits: 2,
    merged: false,
    running: ["server"],
  });
  assert.equal(
    deleteRefusalReason(blocked),
    "worktree has uncommitted changes; tmux session has running commands: server; 2 unique commits are not merged",
  );
  assert.equal(
    pruneIneligibilityReason(blocked),
    "worktree has uncommitted changes; tmux session has running commands: server; worktree is not merged",
  );
});

test("non-force safety protects attached and unknown sessions but allows an idle detached one", () => {
  assert.equal(
    deleteRefusalReason(inspection({ session: "attached" })),
    "tmux session is attached",
  );
  assert.equal(
    pruneIneligibilityReason(inspection({ session: "attached" })),
    "tmux session is attached",
  );
  assert.equal(
    deleteRefusalReason(inspection({ session: "unknown" })),
    "tmux session state is unknown",
  );
  assert.equal(
    pruneIneligibilityReason(inspection({ session: "unknown" })),
    "tmux session state is unknown",
  );
  assert.equal(deleteRefusalReason(inspection({ session: "detached", running: [] })), undefined);
  assert.equal(
    pruneIneligibilityReason(inspection({ session: "detached", running: [] })),
    undefined,
  );
});
