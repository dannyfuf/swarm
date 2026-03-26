import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { DetailView } from "../../components/DetailView.js"
import { Dialog } from "../../components/Dialog.js"
import { HelpDialog } from "../../components/HelpDialog.js"
import type { Worktree } from "../../types/worktree.js"

let testSetup: Awaited<ReturnType<typeof testRender>>

afterEach(() => {
  if (testSetup) {
    testSetup.renderer.destroy()
  }
})

const noop = () => {}

describe("Dialog", () => {
  test("renders title and message", async () => {
    testSetup = await testRender(
      <Dialog
        title="Delete worktree?"
        message="This action cannot be undone."
        onConfirm={noop}
        onCancel={noop}
      />,
      { width: 60, height: 20 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("Delete worktree?")
    expect(frame).toContain("This action cannot be undone.")
    expect(frame).toContain("Cancel")
    expect(frame).toContain("Confirm")
  })
})

describe("HelpDialog", () => {
  test("renders keyboard shortcuts", async () => {
    testSetup = await testRender(<HelpDialog onClose={noop} />, { width: 60, height: 30 })

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("Keyboard Shortcuts")
    expect(frame).toContain("New worktree")
    expect(frame).toContain("Open in tmux")
    expect(frame).toContain("Quit")
  })
})

const mockWorktree: Worktree = {
  slug: "feature_auth",
  branch: "feature/auth",
  path: "/repos/test__wt__feature_auth",
  repoName: "test-repo",
  createdAt: new Date("2026-01-15T10:00:00Z"),
  lastOpenedAt: new Date("2026-01-16T14:00:00Z"),
  tmuxSession: "test-repo--wt--feature_auth",
  isOrphaned: false,
}

describe("DetailView", () => {
  test("renders worktree details", async () => {
    testSetup = await testRender(
      <box width={60} height={20}>
        <DetailView worktree={mockWorktree} status={undefined} />
      </box>,
      { width: 60, height: 20 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("feature/auth")
    expect(frame).toContain("feature_auth")
    expect(frame).toContain("test-repo")
  })

  test("renders empty state when no worktree selected", async () => {
    testSetup = await testRender(
      <box width={60} height={20}>
        <DetailView worktree={null} status={undefined} />
      </box>,
      { width: 60, height: 20 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("Select a worktree")
  })
})
