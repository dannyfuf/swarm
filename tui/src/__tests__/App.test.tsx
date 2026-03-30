import { afterEach, describe, expect, mock, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { App } from "../App.js"
import type { Services } from "../state/AppContext.js"
import { AppProvider } from "../state/AppContext.js"
import type { ContainerConfigSummary } from "../types/container.js"
import type { Repo } from "../types/repo.js"
import type { Worktree } from "../types/worktree.js"

let testSetup: Awaited<ReturnType<typeof testRender>>

afterEach(() => {
  if (testSetup) {
    testSetup.renderer.destroy()
  }
})

const firstRepo: Repo = {
  name: "repo-one",
  path: "/repos/repo-one",
  defaultBranch: "main",
  lastScanned: new Date("2026-01-01T00:00:00Z"),
}

const secondRepo: Repo = {
  name: "repo-two",
  path: "/repos/repo-two",
  defaultBranch: "main",
  lastScanned: new Date("2026-01-01T00:00:00Z"),
}

const firstRepoWorktree: Worktree = {
  slug: "feature-one",
  branch: "feature/one",
  path: "/repos/repo-one__wt__feature-one",
  repoName: "repo-one",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  lastOpenedAt: new Date("2026-01-02T00:00:00Z"),
  tmuxSession: "repo-one--wt--feature-one",
  isOrphaned: false,
}

const secondRepoWorktree: Worktree = {
  slug: "feature-two",
  branch: "feature/two",
  path: "/repos/repo-two__wt__feature-two",
  repoName: "repo-two",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  lastOpenedAt: new Date("2026-01-02T00:00:00Z"),
  tmuxSession: "repo-two--wt--feature-two",
  isOrphaned: false,
}

const missingConfigSummary: ContainerConfigSummary = {
  state: "missing",
  path: "/tmp/config.yml",
  resolvedPath: null,
  exists: false,
  isValid: false,
  preset: null,
  error: null,
}

function createDeferred<TValue>() {
  let resolve: (value: TValue) => void = () => {}
  const promise = new Promise<TValue>((innerResolve) => {
    resolve = innerResolve
  })

  return { promise, resolve }
}

describe("App", () => {
  test("switching repos reloads worktrees for the highlighted repo and ignores stale results", async () => {
    const firstRepoLoad = createDeferred<Worktree[]>()
    const listWorktrees = mock((repo: Repo) => {
      if (repo.path === firstRepo.path) {
        return firstRepoLoad.promise
      }

      return Promise.resolve([secondRepoWorktree])
    })

    const services = {
      repo: {
        scanAll: mock(() => [firstRepo, secondRepo]),
      },
      worktree: {
        list: listWorktrees,
      },
      status: {
        computeAll: mock(() => Promise.resolve(new Map())),
      },
      containerRuntime: {
        getStatuses: mock(() => Promise.resolve(new Map())),
      },
      containerConfig: {
        getSummaryForRepo: mock(() => Promise.resolve(missingConfigSummary)),
      },
      tmux: {},
      git: {},
      github: {},
      safety: {},
      state: {},
      clipboard: {},
      repoIdentity: {},
      dependencyFingerprint: {},
      dockerArtifacts: {},
      containerBuild: {},
      portAllocator: {},
      config: {},
    } as unknown as Services

    testSetup = await testRender(
      <AppProvider services={services}>
        <App />
      </AppProvider>,
      { width: 140, height: 40 },
    )

    await act(async () => {
      await testSetup.renderOnce()
    })

    await act(async () => {
      testSetup.mockInput.pressArrow("down")
      await testSetup.renderOnce()
    })

    await act(async () => {
      firstRepoLoad.resolve([firstRepoWorktree])
      await Promise.resolve()
      await testSetup.renderOnce()
    })

    const frame = testSetup.captureCharFrame()

    expect(listWorktrees).toHaveBeenCalledWith(firstRepo)
    expect(listWorktrees).toHaveBeenCalledWith(secondRepo)
    expect(frame).toContain("feature/two")
    expect(frame).not.toContain("feature/one")
  })
})
