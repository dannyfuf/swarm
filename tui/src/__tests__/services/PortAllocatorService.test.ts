import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { PortAllocatorService } from "../../services/PortAllocatorService.js"
import { StateService } from "../../services/StateService.js"
import type { Config } from "../../types/config.js"
import type { Repo } from "../../types/repo.js"
import type { Worktree } from "../../types/worktree.js"

const tempRoot = join(process.cwd(), "tmp-port-allocator-tests")

const config: Config = {
  aiWorkingDir: tempRoot,
  defaultBaseBranch: "main",
  worktreePattern: "patternA",
  createSessionOnCreate: true,
  tmuxLayoutScript: "",
  statusCacheTTL: 30_000,
  preferFzf: false,
  autoPruneOnRemove: true,
  containerPortRangeStart: 4300,
  containerPortRangeEnd: 4302,
}

const repo: Repo = {
  name: "repo",
  path: "/tmp/repo",
  defaultBranch: "main",
  lastScanned: new Date(),
}

const worktree: Worktree = {
  slug: "feature-x",
  branch: "feature/x",
  path: "/tmp/repo__wt__feature-x",
  repoName: "repo",
  createdAt: new Date(),
  lastOpenedAt: new Date(),
  tmuxSession: "repo--wt--feature-x",
  isOrphaned: false,
}

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

describe("PortAllocatorService", () => {
  test("reuses persisted port when present", async () => {
    await mkdir(tempRoot, { recursive: true })
    const state = new StateService(tempRoot)
    await state.updateWorktree(repo.name, repo.path, repo.defaultBranch, {
      slug: worktree.slug,
      branch: worktree.branch,
      path: worktree.path,
      createdAt: worktree.createdAt,
      lastOpenedAt: worktree.lastOpenedAt,
      tmuxSession: worktree.tmuxSession,
      container: {
        primaryHostPort: 4301,
        containerName: "c",
        networkName: "n",
        dataVolumeNames: ["v"],
        baseImageTag: "base",
        dependencyImageTag: "dep",
        dependencyFingerprint: "abc",
      },
    })

    const allocator = new PortAllocatorService(config, state)
    const port = await allocator.allocate(repo, {
      ...worktree,
      container: {
        primaryHostPort: 4301,
        containerName: "c",
        networkName: "n",
        dataVolumeNames: ["v"],
        baseImageTag: "base",
        dependencyImageTag: "dep",
        dependencyFingerprint: "abc",
      },
    })

    expect(port).toBe(4301)
  })
})
