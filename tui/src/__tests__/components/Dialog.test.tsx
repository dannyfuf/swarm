import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { DetailView } from "../../components/DetailView.js"
import { Dialog } from "../../components/Dialog.js"
import { HelpDialog } from "../../components/HelpDialog.js"
import { InputDialog } from "../../components/InputDialog.js"
import type { ContainerConfigSummary } from "../../types/container.js"
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

  test("renders custom confirm label", async () => {
    testSetup = await testRender(
      <Dialog
        title="Delete worktree?"
        message="This action cannot be undone."
        confirmLabel="Delete"
        onConfirm={noop}
        onCancel={noop}
      />,
      { width: 60, height: 20 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("Delete")
  })
})

describe("InputDialog", () => {
  test("renders title and input placeholder", async () => {
    testSetup = await testRender(
      <InputDialog
        title="New Worktree"
        placeholder="feature/my-branch"
        onSubmit={noop}
        onCancel={noop}
      />,
      { width: 60, height: 20 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("New Worktree")
    expect(frame).toContain("Cancel")
    expect(frame).toContain("Create")
  })
})

describe("HelpDialog", () => {
  test("renders keyboard shortcuts", async () => {
    testSetup = await testRender(<HelpDialog onClose={noop} />, { width: 70, height: 40 })

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("Keyboard Shortcuts")
    expect(frame).toContain("New worktree")
    expect(frame).toContain("New worktree + start")
    expect(frame).toContain("Open in tmux")
    expect(frame).toContain("Start container")
    expect(frame).toContain("Create config scaffold")
    expect(frame).toContain("Copy container config")
    expect(frame).toContain("path")
    expect(frame).toContain("Quit")
  })

  test("renders custom help content", async () => {
    testSetup = await testRender(
      <HelpDialog onClose={noop} title="Container Config" message="Path:\n/tmp/config.yml" />,
      { width: 70, height: 40 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("Container Config")
    expect(frame).toContain("/tmp/config.yml")
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
  container: {
    primaryHostPort: 4301,
    containerName: "test-container",
    networkName: "test-network",
    dataVolumeNames: ["test-volume"],
    baseImageTag: "swarm/test:base",
    dependencyImageTag: "swarm/test:deps-abc",
    dependencyFingerprint: "abc",
  },
  isOrphaned: false,
}

describe("DetailView", () => {
  test("renders worktree details", async () => {
    const containerConfigSummary: ContainerConfigSummary = {
      state: "present",
      path: "/tmp/config.yml",
      resolvedPath: "/tmp/config.yml",
      exists: true,
      isValid: true,
      preset: "node-web",
      error: null,
    }

    testSetup = await testRender(
      <box width={60} height={24}>
        <DetailView
          worktree={mockWorktree}
          status={undefined}
          containerConfigSummary={containerConfigSummary}
          containerStatus={{
            state: "running",
            health: "healthy",
            primaryUrl: "http://127.0.0.1:4301",
            message: "running",
            warning: null,
          }}
        />
      </box>,
      { width: 60, height: 24 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("feature/auth")
    expect(frame).toContain("feature_auth")
    expect(frame).toContain("test-repo")
    expect(frame).toContain("Config")
    expect(frame).toContain("present")
    expect(frame).toContain("node-web")
    expect(frame).toContain("test-container")
  })

  test("renders container warning in detail view", async () => {
    const containerConfigSummary: ContainerConfigSummary = {
      state: "missing",
      path: "/tmp/config.yml",
      resolvedPath: null,
      exists: false,
      isValid: false,
      preset: null,
      error: null,
    }

    testSetup = await testRender(
      <box width={80} height={24}>
        <DetailView
          worktree={mockWorktree}
          status={undefined}
          containerConfigSummary={containerConfigSummary}
          containerStatus={{
            state: "running",
            health: "healthy",
            primaryUrl: "http://127.0.0.1:4301",
            message: "running",
            warning: "Dependency image is stale.",
          }}
        />
      </box>,
      { width: 80, height: 24 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("Warning:")
    expect(frame).toContain("Dependency image is stale.")
  })

  test("renders invalid config state without crashing", async () => {
    const containerConfigSummary: ContainerConfigSummary = {
      state: "invalid",
      path: "/tmp/config.yml",
      resolvedPath: "/tmp/config.yml",
      exists: true,
      isValid: false,
      preset: null,
      error: "Container config schema_version must be 1.",
    }

    testSetup = await testRender(
      <box width={90} height={24}>
        <DetailView
          worktree={mockWorktree}
          status={undefined}
          containerConfigSummary={containerConfigSummary}
          containerStatus={undefined}
        />
      </box>,
      { width: 90, height: 24 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("invalid")
    expect(frame).toContain("Config Error:")
    expect(frame).toContain("schema_version must be 1")
  })

  test("renders active operation label for the selected worktree", async () => {
    const containerConfigSummary: ContainerConfigSummary = {
      state: "present",
      path: "/tmp/config.yml",
      resolvedPath: "/tmp/config.yml",
      exists: true,
      isValid: true,
      preset: "node-web",
      error: null,
    }

    testSetup = await testRender(
      <box width={80} height={24}>
        <DetailView
          worktree={mockWorktree}
          status={undefined}
          containerConfigSummary={containerConfigSummary}
          containerStatus={undefined}
          activeOperationLabel="Starting container for feature/auth..."
        />
      </box>,
      { width: 80, height: 24 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("Operation:")
    expect(frame).toContain("Starting container")
  })

  test("renders empty state when no worktree selected", async () => {
    testSetup = await testRender(
      <box width={60} height={20}>
        <DetailView
          worktree={null}
          status={undefined}
          containerStatus={undefined}
          containerConfigSummary={null}
        />
      </box>,
      { width: 60, height: 20 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("Select a worktree")
  })
})
