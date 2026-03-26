import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { existsSync, rmSync } from "node:fs"
import type { GitService } from "../../services/GitService.js"
import type { StateService } from "../../services/StateService.js"
import type { Config } from "../../types/config.js"
import type { WorktreeInfo } from "../../types/git.js"
import type { Repo } from "../../types/repo.js"

const repo: Repo = {
  name: "test-repo",
  path: "/repos/test-repo",
  defaultBranch: "main",
  lastScanned: new Date(),
}

const config: Config = {
  aiWorkingDir: "/repos",
  defaultBaseBranch: "main",
  worktreePattern: "patternA",
  createSessionOnCreate: true,
  tmuxLayoutScript: "",
  statusCacheTTL: 30000,
  preferFzf: false,
  autoPruneOnRemove: false,
  containerPortRangeStart: 4300,
  containerPortRangeEnd: 4400,
}

function createMockGit(overrides: Partial<GitService> = {}): GitService {
  return {
    worktreeList: mock(() => []),
    worktreeListAsync: mock(() => Promise.resolve([])),
    worktreeAdd: mock(() => {}),
    worktreeAddAsync: mock(() => Promise.resolve()),
    worktreeRemove: mock(() => {}),
    worktreeRemoveAsync: mock(() => Promise.resolve()),
    worktreeRemoveForce: mock(() => {}),
    worktreeRemoveForceAsync: mock(() => Promise.resolve()),
    worktreePrune: mock(() => {}),
    worktreePruneAsync: mock(() => Promise.resolve()),
    defaultBranch: mock(() => "main"),
    branchExists: mock(() => true),
    branchExistsAsync: mock(() => Promise.resolve(true)),
    getBranchInfo: mock(() => ({
      name: "main",
      exists: true,
      hasCommits: true,
      commitCount: 1,
      isMerged: false,
      upstream: "",
      lastCommit: null,
    })),
    getBranchInfoAsync: mock(() =>
      Promise.resolve({
        name: "main",
        exists: true,
        hasCommits: true,
        commitCount: 1,
        isMerged: false,
        upstream: "",
        lastCommit: null,
      }),
    ),
    isMerged: mock(() => false),
    isMergedAsync: mock(() => Promise.resolve(false)),
    deleteBranch: mock(() => {}),
    deleteBranchAsync: mock(() => Promise.resolve()),
    fetchAll: mock(() => {}),
    status: mock(() => ({ modified: [], added: [], deleted: [], untracked: [] })),
    unpushedCommits: mock(() => 0),
    ...overrides,
  } as unknown as GitService
}

function createMockState(overrides: Partial<StateService> = {}): StateService {
  return {
    getRepoWorktrees: mock(() => Promise.resolve({})),
    updateWorktree: mock(() => Promise.resolve()),
    removeWorktree: mock(() => Promise.resolve()),
    updateWorktreeContainer: mock(() => Promise.resolve()),
    ...overrides,
  } as unknown as StateService
}

describe("WorktreeService", () => {
  const mockExistsPaths = new Set<string>([
    "/repos/test-repo",
    "/repos/test-repo__wt__feature",
    "/repos/test-repo__wt__orphan",
  ])

  beforeEach(() => {
    mock.module("node:fs", () => ({
      existsSync: (path: string) => mockExistsPaths.has(path),
      rmSync: mock(() => {}),
    }))
  })

  afterEach(() => {
    mock.module("node:fs", () => ({
      existsSync,
      rmSync,
    }))
  })

  describe("list", () => {
    test("filters out prunable worktree entries", async () => {
      const gitWorktrees: WorktreeInfo[] = [
        {
          path: "/repos/test-repo",
          branch: "main",
          commit: "abc123",
          detached: false,
          prunable: false,
          prunableReason: null,
        },
        {
          path: "/repos/test-repo__wt__feature",
          branch: "feature/x",
          commit: "def456",
          detached: false,
          prunable: false,
          prunableReason: null,
        },
        {
          path: "/repos/deleted-wt",
          branch: "feature/old",
          commit: "ghi789",
          detached: false,
          prunable: true,
          prunableReason: "missing path",
        },
      ]
      const mockGit = createMockGit({ worktreeList: mock(() => gitWorktrees) })
      const mockState = createMockState()
      const { WorktreeService } = await import("../../services/WorktreeService.js")
      const service = new WorktreeService(config, mockGit, mockState)

      const worktrees = await service.list(repo)

      expect(worktrees).toHaveLength(1)
      expect(worktrees[0].path).toBe("/repos/test-repo__wt__feature")
    })

    test("filters out worktrees without on-disk directories", async () => {
      const gitWorktrees: WorktreeInfo[] = [
        {
          path: "/repos/test-repo",
          branch: "main",
          commit: "abc123",
          detached: false,
          prunable: false,
          prunableReason: null,
        },
        {
          path: "/repos/test-repo__wt__feature",
          branch: "feature/x",
          commit: "def456",
          detached: false,
          prunable: false,
          prunableReason: null,
        },
        {
          path: "/repos/nonexistent-path-xyz",
          branch: "feature/y",
          commit: "xyz",
          detached: false,
          prunable: false,
          prunableReason: null,
        },
      ]
      const mockGit = createMockGit({ worktreeList: mock(() => gitWorktrees) })
      const mockState = createMockState()
      const { WorktreeService } = await import("../../services/WorktreeService.js")
      const service = new WorktreeService(config, mockGit, mockState)

      const worktrees = await service.list(repo)

      const paths = worktrees.map((w) => w.path)
      expect(paths.includes("/repos/nonexistent-path-xyz")).toBe(false)
    })

    test("includes orphaned state entries not in git", async () => {
      const gitWorktrees: WorktreeInfo[] = [
        {
          path: "/repos/test-repo",
          branch: "main",
          commit: "abc123",
          detached: false,
          prunable: false,
          prunableReason: null,
        },
      ]
      const mockGit = createMockGit({ worktreeList: mock(() => gitWorktrees) })
      const mockState = createMockState({
        getRepoWorktrees: mock(() =>
          Promise.resolve({
            "orphan-slug": {
              slug: "orphan-slug",
              branch: "feature/orphan",
              path: "/repos/test-repo__wt__orphan",
              createdAt: new Date(),
              lastOpenedAt: new Date(),
              tmuxSession: "test-repo--wt--orphan",
            },
          }),
        ),
      })
      const { WorktreeService } = await import("../../services/WorktreeService.js")
      const service = new WorktreeService(config, mockGit, mockState)

      const worktrees = await service.list(repo)

      expect(worktrees).toHaveLength(1)
      expect(worktrees[0].isOrphaned).toBe(true)
      expect(worktrees[0].slug).toBe("orphan-slug")
    })

    test("skips main repo entry", async () => {
      const gitWorktrees: WorktreeInfo[] = [
        {
          path: "/repos/test-repo",
          branch: "main",
          commit: "abc123",
          detached: false,
          prunable: false,
          prunableReason: null,
        },
      ]
      const mockGit = createMockGit({ worktreeList: mock(() => gitWorktrees) })
      const mockState = createMockState()
      const { WorktreeService } = await import("../../services/WorktreeService.js")
      const service = new WorktreeService(config, mockGit, mockState)

      const worktrees = await service.list(repo)

      expect(worktrees).toHaveLength(0)
    })
  })

  describe("remove", () => {
    test("throws if attempting to delete main repo", async () => {
      const mockGit = createMockGit()
      const mockState = createMockState()
      const { WorktreeService } = await import("../../services/WorktreeService.js")
      const service = new WorktreeService(config, mockGit, mockState)

      const mainRepoWorktree = {
        slug: "main",
        branch: "main",
        path: "/repos/test-repo",
        repoName: "test-repo",
        createdAt: new Date(),
        lastOpenedAt: new Date(),
        tmuxSession: "test-repo--wt--main",
        isOrphaned: false,
      }

      await expect(service.remove(repo, mainRepoWorktree)).rejects.toThrow(
        "Cannot delete the main repository worktree",
      )
    })

    test("verifies worktree is removed from git list after removal", async () => {
      const worktreePath = "/repos/test-repo__wt__feature"
      const worktree = {
        slug: "feature",
        branch: "feature/x",
        path: worktreePath,
        repoName: "test-repo",
        createdAt: new Date(),
        lastOpenedAt: new Date(),
        tmuxSession: "test-repo--wt--feature",
        isOrphaned: false,
      }

      const worktreeListAsyncMock = mock(() =>
        Promise.resolve([
          {
            path: "/repos/test-repo",
            branch: "main",
            commit: "abc",
            detached: false,
            prunable: false,
            prunableReason: null,
          },
        ]),
      )
      const mockGit = createMockGit({
        worktreeListAsync: worktreeListAsyncMock,
      })
      const mockState = createMockState()
      const { WorktreeService } = await import("../../services/WorktreeService.js")
      const service = new WorktreeService(config, mockGit, mockState)

      await service.remove(repo, worktree)

      expect(mockGit.worktreeRemoveAsync).toHaveBeenCalledWith("/repos/test-repo", worktreePath)
      expect(mockState.removeWorktree).toHaveBeenCalledWith("test-repo", "feature")
    })

    test("throws if worktree still in git list after removal", async () => {
      const worktreePath = "/repos/test-repo__wt__feature"
      const worktree = {
        slug: "feature",
        branch: "feature/x",
        path: worktreePath,
        repoName: "test-repo",
        createdAt: new Date(),
        lastOpenedAt: new Date(),
        tmuxSession: "test-repo--wt--feature",
        isOrphaned: false,
      }

      const mockGit = createMockGit({
        worktreeListAsync: mock(() =>
          Promise.resolve([
            {
              path: "/repos/test-repo",
              branch: "main",
              commit: "abc",
              detached: false,
              prunable: false,
              prunableReason: null,
            },
            {
              path: worktreePath,
              branch: "feature/x",
              commit: "def",
              detached: false,
              prunable: false,
              prunableReason: null,
            },
          ]),
        ),
      })
      const mockState = createMockState()
      const { WorktreeService } = await import("../../services/WorktreeService.js")
      const service = new WorktreeService(config, mockGit, mockState)

      await expect(service.remove(repo, worktree)).rejects.toThrow(
        "still appears in git list after removal",
      )
    })

    test("in force mode, continues after git removal failure", async () => {
      const worktreePath = "/repos/test-repo__wt__feature"
      const worktree = {
        slug: "feature",
        branch: "feature/x",
        path: worktreePath,
        repoName: "test-repo",
        createdAt: new Date(),
        lastOpenedAt: new Date(),
        tmuxSession: "test-repo--wt--feature",
        isOrphaned: false,
      }

      const mockGit = createMockGit({
        worktreeRemoveForceAsync: mock(() =>
          Promise.reject(new Error("git worktree remove failed")),
        ),
        worktreeListAsync: mock(() =>
          Promise.resolve([
            {
              path: "/repos/test-repo",
              branch: "main",
              commit: "abc",
              detached: false,
              prunable: false,
              prunableReason: null,
            },
          ]),
        ),
      })
      const mockState = createMockState()
      const { WorktreeService } = await import("../../services/WorktreeService.js")
      const service = new WorktreeService(config, mockGit, mockState)

      await service.remove(repo, worktree, true)

      expect(mockState.removeWorktree).toHaveBeenCalledWith("test-repo", "feature")
    })
  })
})
