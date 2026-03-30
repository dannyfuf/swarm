import { describe, expect, mock, test } from "bun:test"
import { DeleteWorktreeCommand } from "../../commands/DeleteWorktreeCommand.js"
import type { Repo } from "../../types/repo.js"
import type { Worktree } from "../../types/worktree.js"

const repo: Repo = {
  name: "test-repo",
  path: "/repos/test-repo",
  defaultBranch: "main",
  lastScanned: new Date(),
}

const worktree: Worktree = {
  slug: "feature-x",
  branch: "feature/x",
  path: "/repos/test-repo__wt__feature-x",
  repoName: "test-repo",
  createdAt: new Date(),
  lastOpenedAt: new Date(),
  tmuxSession: "test-repo--wt--feature-x",
  isOrphaned: false,
}

describe("DeleteWorktreeCommand", () => {
  test("returns success when deletion completes", async () => {
    const mockWorktreeService = {
      remove: mock(() => Promise.resolve()),
    }
    const mockContainerRuntimeService = {
      removeEnvironment: mock(() => Promise.resolve()),
    }
    const mockGitService = {
      isMerged: mock(() => false),
      isMergedAsync: mock(() => Promise.resolve(false)),
      deleteBranch: mock(() => {}),
      deleteBranchAsync: mock(() => Promise.resolve()),
    }
    const mockTmuxService = {
      hasSession: mock(() => false),
      hasSessionAsync: mock(() => Promise.resolve(false)),
      killSession: mock(() => {}),
      killSessionAsync: mock(() => Promise.resolve()),
    }

    const command = new DeleteWorktreeCommand(
      mockWorktreeService as never,
      mockContainerRuntimeService as never,
      mockGitService as never,
      mockTmuxService as never,
      repo,
      worktree,
    )

    const result = await command.execute()

    expect(result.success).toBe(true)
    expect(result.message).toBe("Deleted worktree: feature/x")
    expect(result.data).toBe(worktree)
  })

  test("removes container environment when worktree has container metadata", async () => {
    const mockWorktreeService = {
      remove: mock(() => Promise.resolve()),
    }
    const mockContainerRuntimeService = {
      removeEnvironment: mock(() => Promise.resolve()),
    }
    const mockGitService = {
      isMerged: mock(() => false),
      isMergedAsync: mock(() => Promise.resolve(false)),
      deleteBranch: mock(() => {}),
      deleteBranchAsync: mock(() => Promise.resolve()),
    }
    const mockTmuxService = {
      hasSession: mock(() => false),
      hasSessionAsync: mock(() => Promise.resolve(false)),
      killSession: mock(() => {}),
      killSessionAsync: mock(() => Promise.resolve()),
    }

    const worktreeWithContainer = {
      ...worktree,
      container: {
        primaryHostPort: 4301,
        containerName: "container-name",
        networkName: "network-name",
        dataVolumeNames: ["vol-data"],
        baseImageTag: "swarm/repo:base",
        dependencyImageTag: "swarm/repo:deps",
        dependencyFingerprint: "fp",
      },
    }

    const command = new DeleteWorktreeCommand(
      mockWorktreeService as never,
      mockContainerRuntimeService as never,
      mockGitService as never,
      mockTmuxService as never,
      repo,
      worktreeWithContainer,
    )

    const result = await command.execute()

    expect(result.success).toBe(true)
    expect(mockContainerRuntimeService.removeEnvironment).toHaveBeenCalledWith(
      worktreeWithContainer,
    )
  })

  test("returns failure when container removal fails", async () => {
    const mockWorktreeService = {
      remove: mock(() => Promise.resolve()),
    }
    const mockContainerRuntimeService = {
      removeEnvironment: mock(() => Promise.reject(new Error("Docker error: permission denied"))),
    }
    const mockGitService = {
      isMerged: mock(() => false),
      isMergedAsync: mock(() => Promise.resolve(false)),
      deleteBranch: mock(() => {}),
      deleteBranchAsync: mock(() => Promise.resolve()),
    }
    const mockTmuxService = {
      hasSession: mock(() => false),
      hasSessionAsync: mock(() => Promise.resolve(false)),
      killSession: mock(() => {}),
      killSessionAsync: mock(() => Promise.resolve()),
    }

    const worktreeWithContainer = {
      ...worktree,
      container: {
        primaryHostPort: 4301,
        containerName: "container-name",
        networkName: "network-name",
        dataVolumeNames: ["vol-data"],
        baseImageTag: "swarm/repo:base",
        dependencyImageTag: "swarm/repo:deps",
        dependencyFingerprint: "fp",
      },
    }

    const command = new DeleteWorktreeCommand(
      mockWorktreeService as never,
      mockContainerRuntimeService as never,
      mockGitService as never,
      mockTmuxService as never,
      repo,
      worktreeWithContainer,
    )

    const result = await command.execute()

    expect(result.success).toBe(false)
    expect(result.message).toContain("Docker error: permission denied")
  })

  test("returns failure when worktree removal fails", async () => {
    const mockWorktreeService = {
      remove: mock(() => Promise.reject(new Error("Cannot delete the main repository worktree"))),
    }
    const mockContainerRuntimeService = {
      removeEnvironment: mock(() => Promise.resolve()),
    }
    const mockGitService = {
      isMerged: mock(() => false),
      isMergedAsync: mock(() => Promise.resolve(false)),
      deleteBranch: mock(() => {}),
      deleteBranchAsync: mock(() => Promise.resolve()),
    }
    const mockTmuxService = {
      hasSession: mock(() => false),
      hasSessionAsync: mock(() => Promise.resolve(false)),
      killSession: mock(() => {}),
      killSessionAsync: mock(() => Promise.resolve()),
    }

    const command = new DeleteWorktreeCommand(
      mockWorktreeService as never,
      mockContainerRuntimeService as never,
      mockGitService as never,
      mockTmuxService as never,
      repo,
      worktree,
    )

    const result = await command.execute()

    expect(result.success).toBe(false)
    expect(result.message).toContain("Cannot delete the main repository worktree")
  })

  test("kills tmux session if it exists", async () => {
    const mockWorktreeService = {
      remove: mock(() => Promise.resolve()),
    }
    const mockContainerRuntimeService = {
      removeEnvironment: mock(() => Promise.resolve()),
    }
    const mockGitService = {
      isMerged: mock(() => false),
      isMergedAsync: mock(() => Promise.resolve(false)),
      deleteBranch: mock(() => {}),
      deleteBranchAsync: mock(() => Promise.resolve()),
    }
    const mockTmuxService = {
      hasSession: mock(() => true),
      hasSessionAsync: mock(() => Promise.resolve(true)),
      killSession: mock(() => {}),
      killSessionAsync: mock(() => Promise.resolve()),
    }

    const command = new DeleteWorktreeCommand(
      mockWorktreeService as never,
      mockContainerRuntimeService as never,
      mockGitService as never,
      mockTmuxService as never,
      repo,
      worktree,
    )

    const result = await command.execute()

    expect(result.success).toBe(true)
    expect(mockTmuxService.killSessionAsync).toHaveBeenCalledWith("test-repo--wt--feature-x")
  })

  test("deletes branch if merged", async () => {
    const mockWorktreeService = {
      remove: mock(() => Promise.resolve()),
    }
    const mockContainerRuntimeService = {
      removeEnvironment: mock(() => Promise.resolve()),
    }
    const mockGitService = {
      isMerged: mock(() => true),
      isMergedAsync: mock(() => Promise.resolve(true)),
      deleteBranch: mock(() => {}),
      deleteBranchAsync: mock(() => Promise.resolve()),
    }
    const mockTmuxService = {
      hasSession: mock(() => false),
      hasSessionAsync: mock(() => Promise.resolve(false)),
      killSession: mock(() => {}),
      killSessionAsync: mock(() => Promise.resolve()),
    }

    const command = new DeleteWorktreeCommand(
      mockWorktreeService as never,
      mockContainerRuntimeService as never,
      mockGitService as never,
      mockTmuxService as never,
      repo,
      worktree,
    )

    const result = await command.execute()

    expect(result.success).toBe(true)
    expect(mockGitService.deleteBranchAsync).toHaveBeenCalledWith("/repos/test-repo", "feature/x")
  })
})
