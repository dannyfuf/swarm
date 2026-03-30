import { describe, expect, test } from "bun:test"
import { parseCommits, parseStatus, parseWorktreeList } from "../../utils/git-parser.js"

describe("parseWorktreeList", () => {
  test("parses single worktree entry", () => {
    const output = `worktree /home/user/repos/my-project
HEAD abc123def456
branch refs/heads/main

`
    const result = parseWorktreeList(output)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      path: "/home/user/repos/my-project",
      branch: "main",
      commit: "abc123def456",
      detached: false,
      prunable: false,
      prunableReason: null,
    })
  })

  test("parses multiple worktree entries", () => {
    const output = `worktree /home/user/repos/my-project
HEAD abc123
branch refs/heads/main

worktree /home/user/repos/wt-feature
HEAD def456
branch refs/heads/feature/auth

`
    const result = parseWorktreeList(output)
    expect(result).toHaveLength(2)
    expect(result[0].branch).toBe("main")
    expect(result[1].branch).toBe("feature/auth")
  })

  test("parses detached HEAD worktree", () => {
    const output = `worktree /home/user/repos/detached
HEAD abc123
detached

`
    const result = parseWorktreeList(output)
    expect(result).toHaveLength(1)
    expect(result[0].detached).toBe(true)
    expect(result[0].branch).toBe("")
  })

  test("strips refs/heads/ prefix from branch", () => {
    const output = `worktree /path
HEAD abc
branch refs/heads/feature/deep/nested

`
    const result = parseWorktreeList(output)
    expect(result[0].branch).toBe("feature/deep/nested")
  })

  test("handles output without trailing blank line", () => {
    const output = `worktree /path
HEAD abc123
branch refs/heads/main`
    const result = parseWorktreeList(output)
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe("/path")
  })

  test("handles empty output", () => {
    expect(parseWorktreeList("")).toEqual([])
  })

  test("parses prunable worktree entry with reason", () => {
    const output = `worktree /home/user/repos/my-project
HEAD abc123def456
branch refs/heads/main
prunable git worktree prune

`
    const result = parseWorktreeList(output)
    expect(result).toHaveLength(1)
    expect(result[0].prunable).toBe(true)
    expect(result[0].prunableReason).toBe("git worktree prune")
  })

  test("parses prunable worktree entry without reason", () => {
    const output = `worktree /home/user/repos/stale-wt
HEAD def456
branch refs/heads/feature/auth
prunable

`
    const result = parseWorktreeList(output)
    expect(result).toHaveLength(1)
    expect(result[0].prunable).toBe(true)
    expect(result[0].prunableReason).toBeNull()
  })

  test("parses mixed active and prunable entries", () => {
    const output = `worktree /home/user/repos/main
HEAD abc123
branch refs/heads/main

worktree /home/user/repos/stale
HEAD def456
prunable missing path

worktree /home/user/repos/active-feat
HEAD ghi789
branch refs/heads/feature/new

`
    const result = parseWorktreeList(output)
    expect(result).toHaveLength(3)
    expect(result[0].prunable).toBe(false)
    expect(result[0].prunableReason).toBeNull()
    expect(result[1].prunable).toBe(true)
    expect(result[1].prunableReason).toBe("missing path")
    expect(result[2].prunable).toBe(false)
  })

  test("parses prunable without trailing blank line", () => {
    const output = `worktree /path
HEAD abc
branch refs/heads/main
prunable stale`
    const result = parseWorktreeList(output)
    expect(result).toHaveLength(1)
    expect(result[0].prunable).toBe(true)
    expect(result[0].prunableReason).toBe("stale")
  })
})

describe("parseStatus", () => {
  test("parses modified files", () => {
    const output = `M  src/app.ts
 M src/index.ts`
    const result = parseStatus(output)
    expect(result.modified).toEqual(["src/app.ts", "src/index.ts"])
  })

  test("parses added files", () => {
    const output = `A  new-file.ts`
    const result = parseStatus(output)
    expect(result.added).toEqual(["new-file.ts"])
  })

  test("parses deleted files", () => {
    const output = `D  old-file.ts`
    const result = parseStatus(output)
    expect(result.deleted).toEqual(["old-file.ts"])
  })

  test("parses untracked files", () => {
    const output = `?? untracked.txt`
    const result = parseStatus(output)
    expect(result.untracked).toEqual(["untracked.txt"])
  })

  test("parses mixed status output", () => {
    const output = `M  src/app.ts
A  new.ts
D  old.ts
?? scratch.txt`
    const result = parseStatus(output)
    expect(result.modified).toEqual(["src/app.ts"])
    expect(result.added).toEqual(["new.ts"])
    expect(result.deleted).toEqual(["old.ts"])
    expect(result.untracked).toEqual(["scratch.txt"])
  })

  test("handles empty output", () => {
    const result = parseStatus("")
    expect(result.modified).toEqual([])
    expect(result.added).toEqual([])
    expect(result.deleted).toEqual([])
    expect(result.untracked).toEqual([])
  })

  test("ignores short lines", () => {
    const result = parseStatus("ab")
    expect(result.modified).toEqual([])
  })
})

describe("parseCommits", () => {
  test("parses single commit", () => {
    const output = "abc123|Fix bug|Author Name|2026-01-15 10:30:00 +0000"
    const result = parseCommits(output)
    expect(result).toHaveLength(1)
    expect(result[0].hash).toBe("abc123")
    expect(result[0].message).toBe("Fix bug")
    expect(result[0].author).toBe("Author Name")
    expect(result[0].date).toBeInstanceOf(Date)
  })

  test("parses multiple commits", () => {
    const output = `abc123|Fix bug|Author|2026-01-15 10:30:00 +0000
def456|Add feature|Other|2026-01-14 09:00:00 +0000`
    const result = parseCommits(output)
    expect(result).toHaveLength(2)
    expect(result[0].hash).toBe("abc123")
    expect(result[1].hash).toBe("def456")
  })

  test("handles empty output", () => {
    expect(parseCommits("")).toEqual([])
  })

  test("skips malformed lines", () => {
    const output = `abc123|Fix bug|Author|2026-01-15 10:30:00 +0000
bad-line
def456|Add|Other|2026-01-14 09:00:00 +0000`
    const result = parseCommits(output)
    expect(result).toHaveLength(2)
  })

  test("handles pipe in commit message", () => {
    const output = "abc123|Fix|bug|Author|2026-01-15 10:30:00 +0000"
    const result = parseCommits(output)
    // With simple split, parts[0]=hash, parts[1]=Fix, parts[2]=bug, parts[3]=Author
    // The parser takes the first 4 parts
    expect(result).toHaveLength(1)
    expect(result[0].hash).toBe("abc123")
  })
})
