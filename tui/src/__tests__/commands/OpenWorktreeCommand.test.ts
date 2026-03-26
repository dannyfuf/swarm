import { describe, expect, mock, test } from "bun:test"
import { OpenWorktreeCommand } from "../../commands/OpenWorktreeCommand.js"
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

describe("OpenWorktreeCommand", () => {
  test("creates session and attaches when session does not exist", async () => {
    const mockTmuxService = {
      hasSession: mock(() => false),
      createSession: mock(() => {}),
      attachSession: mock(() => {}),
    }
    const mockWorktreeService = {
      updateLastOpened: mock(() => Promise.resolve()),
    }

    const cmd = new OpenWorktreeCommand(
      mockTmuxService as never,
      mockWorktreeService as never,
      repo,
      worktree,
    )
    const result = await cmd.execute()

    expect(result.success).toBe(true)
    expect(mockTmuxService.createSession).toHaveBeenCalledWith(
      "test-repo--wt--feature-x",
      "/repos/test-repo__wt__feature-x",
    )
    expect(mockTmuxService.attachSession).toHaveBeenCalledWith("test-repo--wt--feature-x")
  })

  test("does not create session when it already exists", async () => {
    const mockTmuxService = {
      hasSession: mock(() => true),
      createSession: mock(() => {}),
      attachSession: mock(() => {}),
    }
    const mockWorktreeService = {
      updateLastOpened: mock(() => Promise.resolve()),
    }

    const cmd = new OpenWorktreeCommand(
      mockTmuxService as never,
      mockWorktreeService as never,
      repo,
      worktree,
    )
    const result = await cmd.execute()

    expect(result.success).toBe(true)
    expect(mockTmuxService.createSession).not.toHaveBeenCalled()
    expect(mockTmuxService.attachSession).toHaveBeenCalledWith("test-repo--wt--feature-x")
  })

  test("updates last opened timestamp on success", async () => {
    const mockTmuxService = {
      hasSession: mock(() => true),
      attachSession: mock(() => {}),
    }
    const mockWorktreeService = {
      updateLastOpened: mock(() => Promise.resolve()),
    }

    const cmd = new OpenWorktreeCommand(
      mockTmuxService as never,
      mockWorktreeService as never,
      repo,
      worktree,
    )
    await cmd.execute()

    expect(mockWorktreeService.updateLastOpened).toHaveBeenCalledWith(repo, worktree)
  })

  test("returns failure on error", async () => {
    const mockTmuxService = {
      hasSession: mock(() => {
        throw new Error("tmux not found")
      }),
    }
    const mockWorktreeService = {
      updateLastOpened: mock(() => Promise.resolve()),
    }

    const cmd = new OpenWorktreeCommand(
      mockTmuxService as never,
      mockWorktreeService as never,
      repo,
      worktree,
    )
    const result = await cmd.execute()

    expect(result.success).toBe(false)
    expect(result.message).toContain("tmux not found")
  })
})
