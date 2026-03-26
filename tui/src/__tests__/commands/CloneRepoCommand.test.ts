import { describe, expect, test } from "bun:test"
import { CloneRepoCommand } from "../../commands/CloneRepoCommand.js"
import type { RemoteRepo } from "../../types/github.js"

const mockRepo: RemoteRepo = {
  fullName: "owner/repo",
  name: "repo",
  cloneUrl: "https://github.com/owner/repo.git",
  description: "Test repository",
  isPrivate: false,
  defaultBranch: "main",
  updatedAt: "2026-01-01T00:00:00Z",
}

describe("CloneRepoCommand", () => {
  test("clones repo successfully", async () => {
    const command = new CloneRepoCommand(
      { cloneRepo: async () => undefined } as never,
      "/tmp/ai_working",
      mockRepo,
    )

    const result = await command.execute()

    expect(result.success).toBe(true)
    expect(result.message).toContain("Cloned owner/repo")
    expect(result.data).toEqual({ path: "/tmp/ai_working/repo" })
  })

  test("returns failure when repo already exists", async () => {
    const command = new CloneRepoCommand({ cloneRepo: async () => undefined } as never, "/usr", {
      ...mockRepo,
      name: "bin",
    })

    const result = await command.execute()

    expect(result.success).toBe(false)
    expect(result.message).toContain("already exists")
  })

  test("returns failure when clone fails", async () => {
    const command = new CloneRepoCommand(
      {
        cloneRepo: async () => {
          throw new Error("git clone failed: authentication required")
        },
      } as never,
      "/tmp/ai_working",
      mockRepo,
    )

    const result = await command.execute()

    expect(result.success).toBe(false)
    expect(result.message).toContain("git clone failed")
  })
})
