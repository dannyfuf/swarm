import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PrRepoSlice, PullRequest } from "../core/types.ts";
import { createFakeGithub } from "../testing/fakeGithub.ts";
import { pullRequest } from "../testing/fixtures.ts";
import { createPrService } from "./prs.ts";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      assert.ok(resolvePromise);
      resolvePromise(value);
    },
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("createPrService", () => {
  test("finds an open PR by repository and branch", async () => {
    const pr = pullRequest({ repoId: "acme/app", headRefName: "feat/exports" });
    const github = createFakeGithub({
      prsByRepoBranch: { "acme/app:feat/exports": pr },
    });
    const service = createPrService({ github, ttlSeconds: 90 });

    assert.deepEqual(await service.findByBranch("acme/app", "feat/exports"), pr);
    assert.deepEqual(github.calls, [
      {
        method: "findPullRequest",
        args: [{ owner: "acme", name: "app" }, "feat/exports"],
      },
    ]);
  });

  test("shares a four-call limiter across tabs and overlapping loads", async () => {
    const github = createFakeGithub();
    let active = 0;
    let maximum = 0;
    github.listPullRequests = async (repo, _tab, opts) => {
      assert.ok(opts?.signal);
      active += 1;
      maximum = Math.max(maximum, active);
      await flush();
      active -= 1;
      const repoId = `${repo.owner}/${repo.name}`;
      return {
        prs: [pullRequest({ repoId, number: Number(repo.name.split("-").at(-1)) })],
        fetchedAt: "2026-01-01T00:00:00.000Z",
      };
    };
    const service = createPrService({ github, ttlSeconds: 45 });
    const load = (repoIds: string[], tab: "mine" | "review") =>
      service.load(repoIds, tab, { force: true, onSlice() {} });

    await Promise.all([
      load(["acme/mine-1", "acme/mine-2", "acme/mine-3"], "mine"),
      load(["acme/review-4", "acme/review-5", "acme/review-6"], "review"),
      load(["acme/more-7", "acme/more-8", "acme/more-9"], "mine"),
    ]);

    assert.equal(maximum, 4);
  });

  test("emits a stale cache before a deferred refresh resolves", async () => {
    const cached = pullRequest({ number: 10 });
    const refreshed = pullRequest({ number: 11 });
    const github = createFakeGithub({
      prCacheByRepoTab: {
        "bukhr/payroll:mine": {
          prs: [cached],
          fetchedAt: "2025-12-31T00:00:00.000Z",
          stale: true,
        },
      },
    });
    const network = deferred<{ prs: PullRequest[]; fetchedAt: string }>();
    github.listPullRequests = async () => network.promise;
    const service = createPrService({ github, ttlSeconds: 90 });
    const events: PrRepoSlice[] = [];

    const pending = service.load(["bukhr/payroll"], "mine", {
      onSlice(_repoId, slice) {
        events.push(slice);
      },
    });
    await flush();

    assert.equal(events.length, 1);
    assert.equal(events[0]?.prs[0]?.number, 10);
    assert.equal(events[0]?.loading, true);

    network.resolve({ prs: [refreshed], fetchedAt: "2026-01-01T00:00:00.000Z" });
    await pending;
    assert.equal(events[1]?.prs[0]?.number, 11);
    assert.equal(events[1]?.loading, false);
  });

  test("keeps cached PRs and adds a short error when refresh fails", async () => {
    const cached = pullRequest({ number: 20 });
    const github = createFakeGithub({
      prCacheByRepoTab: {
        "bukhr/payroll:review": {
          prs: [cached],
          fetchedAt: "2025-12-31T00:00:00.000Z",
          stale: true,
        },
      },
      prErrors: { "bukhr/payroll:review": new Error(`offline\n${"detail".repeat(50)}`) },
    });
    const service = createPrService({ github, ttlSeconds: 90 });
    let final: PrRepoSlice | undefined;

    await service.load(["bukhr/payroll"], "review", {
      onSlice(_repoId, slice) {
        final = slice;
      },
    });

    assert.deepEqual(final?.prs, [cached]);
    assert.equal(final?.error, "offline");
    assert.equal(final?.loading, false);
  });

  test("does not refresh a fresh cache unless forced", async () => {
    const cached = pullRequest({ number: 30 });
    const github = createFakeGithub({
      prCacheByRepoTab: {
        "bukhr/payroll:mine": {
          prs: [cached],
          fetchedAt: "2026-01-01T00:00:00.000Z",
          stale: false,
        },
      },
    });
    const service = createPrService({ github, ttlSeconds: 90 });
    const events: PrRepoSlice[] = [];

    await service.load(["bukhr/payroll"], "mine", {
      onSlice(_repoId, slice) {
        events.push(slice);
      },
    });

    assert.deepEqual(events, [
      { prs: [cached], fetchedAt: "2026-01-01T00:00:00.000Z", loading: false },
    ]);
    assert.equal(
      github.calls.some(({ method }) => method === "listPullRequests"),
      false,
    );
  });

  test("aborts and ignores a superseded repo-tab completion", async () => {
    const github = createFakeGithub();
    const first = deferred<{ prs: PullRequest[]; fetchedAt: string }>();
    const older = pullRequest({ number: 40 });
    const newer = pullRequest({ number: 41 });
    let call = 0;
    let firstSignal: AbortSignal | undefined;
    github.listPullRequests = async (_repo, _tab, opts) => {
      call += 1;
      if (call === 1) {
        firstSignal = opts?.signal;
        return first.promise;
      }
      return { prs: [newer], fetchedAt: "2026-01-02T00:00:00.000Z" };
    };
    const service = createPrService({ github, ttlSeconds: 90 });
    const finalNumbers: number[] = [];
    const onSlice = (_repoId: string, slice: PrRepoSlice): void => {
      if (!slice.loading) finalNumbers.push(...slice.prs.map(({ number }) => number));
    };

    const oldLoad = service.load(["bukhr/payroll"], "mine", { force: true, onSlice });
    await flush();
    const newLoad = service.load(["bukhr/payroll"], "mine", { force: true, onSlice });
    await newLoad;

    assert.equal(firstSignal?.aborted, true);
    first.resolve({ prs: [older], fetchedAt: "2026-01-01T00:00:00.000Z" });
    await oldLoad;
    assert.deepEqual(finalNumbers, [41]);
  });

  test("isolates a repo error from successful peers", async () => {
    const good = pullRequest({ repoId: "acme/good" });
    const github = createFakeGithub({
      prsByRepoTab: { "acme/good:review": [good] },
      prErrors: { "acme/bad:review": new Error("gh: not authenticated") },
    });
    const service = createPrService({ github, ttlSeconds: 90 });
    const finals = new Map<string, PrRepoSlice>();

    await service.load(["acme/good", "acme/bad"], "review", {
      onSlice(repoId, slice) {
        if (!slice.loading) finals.set(repoId, slice);
      },
    });

    assert.deepEqual(finals.get("acme/good")?.prs, [good]);
    assert.equal(finals.get("acme/bad")?.error, "gh: not authenticated");
  });
});
