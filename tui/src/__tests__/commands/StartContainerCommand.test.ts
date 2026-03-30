import { describe, expect, test } from "bun:test"
import { StartContainerCommand } from "../../commands/StartContainerCommand.js"
import type { Repo } from "../../types/repo.js"
import type { Worktree } from "../../types/worktree.js"

const repo: Repo = {
  name: "repo",
  path: "/repo",
  defaultBranch: "main",
  lastScanned: new Date(),
}

const worktree: Worktree = {
  slug: "feature-x",
  branch: "feature/x",
  path: "/repo__wt__feature-x",
  repoName: "repo",
  createdAt: new Date(),
  lastOpenedAt: new Date(),
  tmuxSession: "repo--wt--feature-x",
  isOrphaned: false,
}

describe("StartContainerCommand", () => {
  test("creates config scaffold when repo config is missing", async () => {
    const command = new StartContainerCommand(
      {
        ensureConfigScaffold: async () => ({
          path: "/config/swarm/containers/repo",
          composeFilePath: "/config/swarm/containers/repo/docker-compose.yml",
          alreadyExisted: false,
          contents: "services:\n  app:\n    image: node:22",
        }),
      } as never,
      {
        start: async () => {
          throw new Error(
            "Missing repo dockerization directory for repo. Expected: /config/swarm/containers/repo",
          )
        },
      } as never,
      {
        updateContainerMetadata: async () => undefined,
      } as never,
      repo,
      worktree,
    )

    const result = await command.execute()

    expect(result.success).toBe(false)
    expect(result.message).toContain("Created repo dockerization scaffold")
    expect(result.data).toEqual({
      path: "/config/swarm/containers/repo",
      composeFilePath: "/config/swarm/containers/repo/docker-compose.yml",
      alreadyExisted: false,
      contents: "services:\n  app:\n    image: node:22",
    })
  })
})
