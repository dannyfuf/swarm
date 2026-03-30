import { describe, expect, mock, test } from "bun:test"
import { OpenWorktreeCommand } from "../../commands/OpenWorktreeCommand.js"
import type { TmuxService } from "../../services/TmuxService.js"
import type { WorktreeService } from "../../services/WorktreeService.js"
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
    const mockTmuxService: Pick<
      TmuxService,
      "hasSession" | "createSession" | "applyConfiguredLayout" | "attachSession"
    > = {
      hasSession: mock(() => false),
      createSession: mock(() => {}),
      applyConfiguredLayout: mock(() => {}),
      attachSession: mock(() => {}),
    }
    const mockWorktreeService: Pick<WorktreeService, "updateLastOpened"> = {
      updateLastOpened: mock(() => Promise.resolve()),
    }

    const cmd = new OpenWorktreeCommand(
      mockTmuxService as TmuxService,
      mockWorktreeService as WorktreeService,
      repo,
      worktree,
    )
    const result = await cmd.execute()

    expect(result.success).toBe(true)
    expect(mockTmuxService.createSession).toHaveBeenCalledWith(
      "test-repo--wt--feature-x",
      "/repos/test-repo__wt__feature-x",
    )
    expect(mockTmuxService.applyConfiguredLayout).toHaveBeenCalledWith(
      "test-repo--wt--feature-x",
      "/repos/test-repo__wt__feature-x",
    )
    expect(mockTmuxService.attachSession).toHaveBeenCalledWith("test-repo--wt--feature-x")
  })

  test("does not create session when it already exists", async () => {
    const mockTmuxService: Pick<
      TmuxService,
      "hasSession" | "createSession" | "applyConfiguredLayout" | "attachSession"
    > = {
      hasSession: mock(() => true),
      createSession: mock(() => {}),
      applyConfiguredLayout: mock(() => {}),
      attachSession: mock(() => {}),
    }
    const mockWorktreeService: Pick<WorktreeService, "updateLastOpened"> = {
      updateLastOpened: mock(() => Promise.resolve()),
    }

    const cmd = new OpenWorktreeCommand(
      mockTmuxService as TmuxService,
      mockWorktreeService as WorktreeService,
      repo,
      worktree,
    )
    const result = await cmd.execute()

    expect(result.success).toBe(true)
    expect(mockTmuxService.createSession).not.toHaveBeenCalled()
    expect(mockTmuxService.applyConfiguredLayout).not.toHaveBeenCalled()
    expect(mockTmuxService.attachSession).toHaveBeenCalledWith("test-repo--wt--feature-x")
  })

  test("updates last opened timestamp on success", async () => {
    const mockTmuxService: Pick<
      TmuxService,
      "hasSession" | "applyConfiguredLayout" | "attachSession"
    > = {
      hasSession: mock(() => true),
      applyConfiguredLayout: mock(() => {}),
      attachSession: mock(() => {}),
    }
    const mockWorktreeService: Pick<WorktreeService, "updateLastOpened"> = {
      updateLastOpened: mock(() => Promise.resolve()),
    }

    const cmd = new OpenWorktreeCommand(
      mockTmuxService as TmuxService,
      mockWorktreeService as WorktreeService,
      repo,
      worktree,
    )
    await cmd.execute()

    expect(mockWorktreeService.updateLastOpened).toHaveBeenCalledWith(repo, worktree)
  })

  test("returns failure on error", async () => {
    const mockTmuxService: Pick<TmuxService, "hasSession"> = {
      hasSession: mock(() => {
        throw new Error("tmux not found")
      }),
    }
    const mockWorktreeService: Pick<WorktreeService, "updateLastOpened"> = {
      updateLastOpened: mock(() => Promise.resolve()),
    }

    const cmd = new OpenWorktreeCommand(
      mockTmuxService as TmuxService,
      mockWorktreeService as WorktreeService,
      repo,
      worktree,
    )
    const result = await cmd.execute()

    expect(result.success).toBe(false)
    expect(result.message).toContain("tmux not found")
  })

  test("returns failure when applying the tmux layout fails", async () => {
    const mockTmuxService: Pick<
      TmuxService,
      "hasSession" | "createSession" | "applyConfiguredLayout" | "attachSession"
    > = {
      hasSession: mock(() => false),
      createSession: mock(() => {}),
      applyConfiguredLayout: mock(() => {
        throw new Error("Failed to apply tmux layout: layout script exited 1")
      }),
      attachSession: mock(() => {}),
    }
    const mockWorktreeService: Pick<WorktreeService, "updateLastOpened"> = {
      updateLastOpened: mock(() => Promise.resolve()),
    }

    const cmd = new OpenWorktreeCommand(
      mockTmuxService as TmuxService,
      mockWorktreeService as WorktreeService,
      repo,
      worktree,
    )
    const result = await cmd.execute()

    expect(result.success).toBe(false)
    expect(result.message).toContain("Failed to apply tmux layout")
    expect(mockTmuxService.attachSession).not.toHaveBeenCalled()
  })
})
