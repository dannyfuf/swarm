/**
 * Git output parsing utilities.
 *
 * Ports the Go `internal/git/parser.go` logic for parsing porcelain-format
 * output from git commands into structured TypeScript objects.
 */

import type { Commit, StatusResult, WorktreeInfo } from "../types/git.js"

/**
 * Parse `git worktree list --porcelain` output into structured entries.
 *
 * Porcelain format is a series of blocks separated by blank lines:
 * ```
 * worktree /path/to/worktree
 * HEAD abc123...
 * branch refs/heads/main
 *
 * worktree /path/to/other
 * HEAD def456...
 * detached
 * ```
 */
export function parseWorktreeList(output: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = []
  let current: Partial<WorktreeInfo> | null = null

  const lines = output.split("\n")
  for (const rawLine of lines) {
    const line = rawLine.trim()

    if (line === "") {
      if (current?.path) {
        worktrees.push({
          path: current.path,
          branch: current.branch ?? "",
          commit: current.commit ?? "",
          detached: current.detached ?? false,
        })
      }
      current = null
      continue
    }

    const spaceIndex = line.indexOf(" ")
    const key = spaceIndex === -1 ? line : line.slice(0, spaceIndex)
    const value = spaceIndex === -1 ? "" : line.slice(spaceIndex + 1)

    if (key === "worktree") {
      current = { path: value }
    } else if (current) {
      switch (key) {
        case "HEAD":
          current.commit = value
          break
        case "branch":
          // refs/heads/feature/foo -> feature/foo
          current.branch = value.replace(/^refs\/heads\//, "")
          break
        case "detached":
          current.detached = true
          break
      }
    }
  }

  // Don't forget the last entry (if output doesn't end with blank line)
  if (current?.path) {
    worktrees.push({
      path: current.path,
      branch: current.branch ?? "",
      commit: current.commit ?? "",
      detached: current.detached ?? false,
    })
  }

  return worktrees
}

/**
 * Parse `git status --porcelain` output into categorized file lists.
 *
 * Each line has a 2-character status code followed by a space and filename:
 * ```
 * M  src/app.ts
 * ?? untracked.txt
 * A  new-file.ts
 * ```
 */
export function parseStatus(output: string): StatusResult {
  const result: StatusResult = {
    modified: [],
    added: [],
    deleted: [],
    untracked: [],
  }

  const lines = output.split("\n")
  for (const line of lines) {
    if (line.length < 4) continue

    const indexStatus = line[0]
    const workTreeStatus = line[1]
    const file = line.slice(3).trim()

    if (indexStatus === "M" || workTreeStatus === "M") {
      result.modified.push(file)
    } else if (indexStatus === "A") {
      result.added.push(file)
    } else if (indexStatus === "D" || workTreeStatus === "D") {
      result.deleted.push(file)
    } else if (indexStatus === "?" && workTreeStatus === "?") {
      result.untracked.push(file)
    }
  }

  return result
}

/**
 * Parse pipe-delimited commit log output.
 *
 * Expected format from `--pretty=format:%H|%s|%an|%ad --date=iso`:
 * ```
 * abc123|Fix bug|Author Name|2026-01-15 10:30:00 +0000
 * ```
 */
export function parseCommits(output: string): Commit[] {
  const commits: Commit[] = []

  const lines = output.split("\n")
  for (const line of lines) {
    if (line === "") continue

    const parts = line.split("|")
    if (parts.length < 4) continue

    commits.push({
      hash: parts[0],
      message: parts[1],
      author: parts[2],
      date: new Date(parts[3]),
    })
  }

  return commits
}
