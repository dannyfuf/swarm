import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { WorktreeList } from "../../components/WorktreeList.js"
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

  test("shows GONE tag for orphaned worktrees", async () => {
    testSetup = await testRender(
      <box width={50} height={20} flexDirection="column">
        <WorktreeList
          worktrees={mockWorktrees}
          statuses={new Map()}
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

    expect(frame).toContain("[GONE]")
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
})
