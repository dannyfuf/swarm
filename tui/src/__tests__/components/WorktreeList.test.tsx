import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { WorktreeList } from "../../components/WorktreeList.js"
import type { ContainerRuntimeStatus } from "../../types/container.js"
import type { Status } from "../../types/status.js"
import type { Worktree } from "../../types/worktree.js"

let testSetup: Awaited<ReturnType<typeof testRender>>

afterEach(() => {
  if (testSetup) {
    testSetup.renderer.destroy()
  }
})

const mockWorktrees: Worktree[] = [
  {
    slug: "feature_auth",
    branch: "feature/auth",
    path: "/repos/test__wt__feature_auth",
    repoName: "test",
    createdAt: new Date("2026-01-01"),
    lastOpenedAt: new Date("2026-01-02"),
    tmuxSession: "test--wt--feature_auth",
    isOrphaned: false,
  },
  {
    slug: "fix_bug",
    branch: "fix/bug",
    path: "/repos/test__wt__fix_bug",
    repoName: "test",
    createdAt: new Date("2026-01-01"),
    lastOpenedAt: new Date("2026-01-02"),
    tmuxSession: "test--wt--fix_bug",
    isOrphaned: true,
  },
]

const noop = () => {}

describe("WorktreeList", () => {
  test("renders worktree branch names", async () => {
    testSetup = await testRender(
      <box width={50} height={20} flexDirection="column">
        <WorktreeList
          worktrees={mockWorktrees}
          statuses={new Map()}
          containerStatuses={new Map()}
          selectedIndex={0}
          focused={true}
          onSelect={noop}
          onChange={noop}
        />
      </box>,
      { width: 50, height: 20 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("feature/auth")
  })

  test("shows gone indicator for orphaned worktrees", async () => {
    testSetup = await testRender(
      <box width={50} height={20} flexDirection="column">
        <WorktreeList
          worktrees={mockWorktrees}
          statuses={new Map()}
          containerStatuses={new Map()}
          selectedIndex={0}
          focused={true}
          onSelect={noop}
          onChange={noop}
        />
      </box>,
      { width: 50, height: 20 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    // Orphaned worktrees now show "✗ gone" instead of "[GONE]"
    expect(frame).toContain("gone")
    expect(frame).toContain("✗")
  })

  test("shows badges when status has changes", async () => {
    const statuses = new Map<string, Status>([
      [
        "/repos/test__wt__feature_auth",
        {
          hasChanges: true,
          hasUnpushed: true,
          branchMerged: null,
          isOrphaned: false,
          computedAt: new Date(),
        },
      ],
    ])

    testSetup = await testRender(
      <box width={50} height={20} flexDirection="column">
        <WorktreeList
          worktrees={mockWorktrees}
          statuses={statuses}
          containerStatuses={new Map()}
          selectedIndex={0}
          focused={true}
          onSelect={noop}
          onChange={noop}
        />
      </box>,
      { width: 50, height: 20 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    // Should show the uncommitted changes badge (●) and unpushed badge (↑)
    expect(frame).toContain("●")
    expect(frame).toContain("↑")
  })

  test("renders empty state when no worktrees", async () => {
    testSetup = await testRender(
      <box width={50} height={20} flexDirection="column">
        <WorktreeList
          worktrees={[]}
          statuses={new Map()}
          containerStatuses={new Map()}
          selectedIndex={0}
          focused={true}
          onSelect={noop}
          onChange={noop}
        />
      </box>,
      { width: 50, height: 20 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("No worktrees")
  })

  test("shows container runtime badge", async () => {
    const containerStatuses = new Map<string, ContainerRuntimeStatus>([
      [
        "/repos/test__wt__feature_auth",
        {
          state: "running",
          health: "healthy",
          primaryUrl: "http://127.0.0.1:4301",
          message: "running",
          warning: null,
        },
      ],
    ])

    testSetup = await testRender(
      <box width={50} height={20} flexDirection="column">
        <WorktreeList
          worktrees={mockWorktrees}
          statuses={new Map()}
          containerStatuses={containerStatuses}
          selectedIndex={0}
          focused={true}
          onSelect={noop}
          onChange={noop}
        />
      </box>,
      { width: 50, height: 20 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    // Container running now shows "▲" instead of "[UP]"
    expect(frame).toContain("▲")
  })
})
