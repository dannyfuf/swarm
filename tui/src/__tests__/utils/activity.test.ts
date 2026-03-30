import { describe, expect, test } from "bun:test"
import type { AppAction } from "../../state/actions.js"
import type { ActivityDraft } from "../../types/activity.js"
import { createActivityTracker } from "../../utils/activity.js"

const createWorktreeActivity: ActivityDraft = {
  kind: "create-worktree",
  label: "Creating worktree feature/auth...",
  priority: "foreground",
  scope: {
    repoPath: "/repos/test-repo",
    branch: "feature/auth",
  },
}

const startContainerActivity: ActivityDraft = {
  kind: "start-container",
  label: "Starting container for feature/auth...",
  priority: "foreground",
  scope: {
    repoPath: "/repos/test-repo",
    worktreePath: "/repos/test-repo__wt__feature_auth",
  },
}

describe("createActivityTracker", () => {
  test("returns the operation result and clears the activity", async () => {
    const actions: AppAction[] = []
    const tracker = createActivityTracker({
      dispatch: (action) => actions.push(action),
      createId: () => "activity-1",
      now: () => new Date("2026-03-26T10:00:00Z"),
    })

    const result = await tracker(createWorktreeActivity, async () => "done")

    expect(result).toBe("done")
    expect(actions).toEqual([
      {
        type: "BEGIN_ACTIVITY",
        activity: {
          ...createWorktreeActivity,
          id: "activity-1",
          startedAt: new Date("2026-03-26T10:00:00Z"),
        },
      },
      { type: "END_ACTIVITY", id: "activity-1" },
    ])
  })

  test("clears the activity when the operation throws", async () => {
    const actions: AppAction[] = []
    const tracker = createActivityTracker({
      dispatch: (action) => actions.push(action),
      createId: () => "activity-2",
      now: () => new Date("2026-03-26T10:01:00Z"),
    })

    await expect(
      tracker(createWorktreeActivity, async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")

    expect(actions).toEqual([
      {
        type: "BEGIN_ACTIVITY",
        activity: {
          ...createWorktreeActivity,
          id: "activity-2",
          startedAt: new Date("2026-03-26T10:01:00Z"),
        },
      },
      { type: "END_ACTIVITY", id: "activity-2" },
    ])
  })

  test("supports overlapping tracked operations", async () => {
    const actions: AppAction[] = []
    const deferred = createDeferred<void>()
    let nextId = 1
    let nextMinute = 0
    const tracker = createActivityTracker({
      dispatch: (action) => actions.push(action),
      createId: () => `activity-${nextId++}`,
      now: () => new Date(`2026-03-26T10:0${nextMinute++}:00Z`),
    })

    const firstOperation = tracker(createWorktreeActivity, () => deferred.promise)
    const secondOperation = tracker(startContainerActivity, async () => "second-result")

    await secondOperation

    expect(actions.slice(0, 3)).toEqual([
      {
        type: "BEGIN_ACTIVITY",
        activity: {
          ...createWorktreeActivity,
          id: "activity-1",
          startedAt: new Date("2026-03-26T10:00:00Z"),
        },
      },
      {
        type: "BEGIN_ACTIVITY",
        activity: {
          ...startContainerActivity,
          id: "activity-2",
          startedAt: new Date("2026-03-26T10:01:00Z"),
        },
      },
      { type: "END_ACTIVITY", id: "activity-2" },
    ])

    deferred.resolve()
    await firstOperation

    expect(actions[3]).toEqual({ type: "END_ACTIVITY", id: "activity-1" })
  })
})

function createDeferred<TResult>() {
  let resolve: (value: TResult | PromiseLike<TResult>) => void = () => {}
  let reject: (reason?: unknown) => void = () => {}
  const promise = new Promise<TResult>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })

  return { promise, resolve, reject }
}
