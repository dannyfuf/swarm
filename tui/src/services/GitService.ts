/**
 * Git CLI wrapper service for Swarm TUI.
 *
 * Provides methods for all git operations needed by Swarm:
 * worktree management, status, branch operations, and safety checks.
 * All methods shell out to the `git` CLI.
 *
 * Ports the Go `internal/git/client.go`, `internal/git/branch.go`,
 * and `internal/git/safety.go`.
 */

import type { AddOptions, BranchInfo, StatusResult, WorktreeInfo } from "../types/git.js"
import { parseCommits, parseStatus, parseWorktreeList } from "../utils/git-parser.js"
import { exec, execSync } from "../utils/shell.js"

export class GitService {
  /** List all worktrees for a repository. */
  worktreeList(repoPath: string): WorktreeInfo[] {
    const result = execSync("git", ["-C", repoPath, "worktree", "list", "--porcelain"])
    if (!result.success) {
      throw new Error(`git worktree list failed: ${result.stderr}`)
    }
    return parseWorktreeList(result.stdout)
  }

  /** Add a new worktree. */
  worktreeAdd(repoPath: string, opts: AddOptions): void {
    const args = ["-C", repoPath, "worktree", "add"]

    if (opts.newBranch) {
      args.push("-b", opts.branch, opts.path)
      if (opts.baseBranch) {
        args.push(opts.baseBranch)
      }
    } else {
      args.push(opts.path, opts.branch)
    }

    const result = execSync("git", args)
    if (!result.success) {
      throw new Error(`git worktree add failed: ${result.stderr}`)
    }
  }

  /** Remove a worktree by path. */
  worktreeRemove(repoPath: string, worktreePath: string): void {
    const result = execSync("git", ["-C", repoPath, "worktree", "remove", worktreePath])
    if (!result.success) {
      throw new Error(`git worktree remove failed: ${result.stderr}`)
    }
  }

  /** Force-remove a worktree by path. */
  worktreeRemoveForce(repoPath: string, worktreePath: string): void {
    const result = execSync("git", ["-C", repoPath, "worktree", "remove", "--force", worktreePath])
    if (!result.success) {
      throw new Error(`git worktree remove --force failed: ${result.stderr}`)
    }
  }

  /** Prune stale worktree entries. */
  worktreePrune(repoPath: string): void {
    const result = execSync("git", ["-C", repoPath, "worktree", "prune"])
    if (!result.success) {
      throw new Error(`git worktree prune failed: ${result.stderr}`)
    }
  }

  /** Fetch from all remotes. */
  fetchAll(repoPath: string): void {
    const result = execSync("git", ["-C", repoPath, "fetch", "--all"])
    if (!result.success) {
      throw new Error(`git fetch --all failed: ${result.stderr}`)
    }
  }

  /** Get working tree status (porcelain format). */
  status(repoPath: string): StatusResult {
    const result = execSync("git", ["-C", repoPath, "status", "--porcelain"])
    if (!result.success) {
      throw new Error(`git status failed: ${result.stderr}`)
    }
    return parseStatus(result.stdout)
  }

  /**
   * Detect the default branch for a repository.
   * Tries `origin/HEAD`, then falls back to checking "main" and "master".
   */
  defaultBranch(repoPath: string): string {
    // Try origin/HEAD
    const symRef = execSync("git", ["-C", repoPath, "symbolic-ref", "refs/remotes/origin/HEAD"])
    if (symRef.success) {
      // refs/remotes/origin/main -> main
      const ref = symRef.stdout.trim()
      const branch = ref.replace(/^refs\/remotes\/origin\//, "")
      if (branch) return branch
    }

    // Fallback: check if "main" branch exists
    const mainCheck = execSync("git", ["-C", repoPath, "rev-parse", "--verify", "refs/heads/main"])
    if (mainCheck.success) return "main"

    // Fallback: check if "master" branch exists
    const masterCheck = execSync("git", [
      "-C",
      repoPath,
      "rev-parse",
      "--verify",
      "refs/heads/master",
    ])
    if (masterCheck.success) return "master"

    return "main" // Ultimate fallback
  }

  /** Check if a branch exists in the repository. */
  branchExists(repoPath: string, branch: string): boolean {
    const result = execSync("git", [
      "-C",
      repoPath,
      "rev-parse",
      "--verify",
      `refs/heads/${branch}`,
    ])
    return result.success
  }

  /** Get comprehensive information about a branch. */
  getBranchInfo(repoPath: string, branch: string): BranchInfo {
    const info: BranchInfo = {
      name: branch,
      exists: false,
      hasCommits: false,
      commitCount: 0,
      isMerged: false,
      upstream: "",
      lastCommit: null,
    }

    // Check existence
    if (!this.branchExists(repoPath, branch)) {
      return info
    }
    info.exists = true

    // Get commit count
    const countResult = execSync("git", [
      "-C",
      repoPath,
      "rev-list",
      "--count",
      `refs/heads/${branch}`,
    ])
    if (countResult.success) {
      info.commitCount = Number.parseInt(countResult.stdout, 10) || 0
      info.hasCommits = info.commitCount > 0
    }

    // Get upstream tracking branch
    const upstreamResult = execSync("git", [
      "-C",
      repoPath,
      "rev-parse",
      "--abbrev-ref",
      `${branch}@{upstream}`,
    ])
    if (upstreamResult.success) {
      info.upstream = upstreamResult.stdout.trim()
    }

    // Get last commit
    const logResult = execSync("git", [
      "-C",
      repoPath,
      "log",
      "-1",
      "--pretty=format:%H|%s|%an|%ad",
      "--date=iso",
      `refs/heads/${branch}`,
    ])
    if (logResult.success && logResult.stdout) {
      const commits = parseCommits(logResult.stdout)
      if (commits.length > 0) {
        info.lastCommit = commits[0]
      }
    }

    // Check merge status
    info.isMerged = this.isMerged(repoPath, branch)

    return info
  }

  /** Check if a branch is merged into the default branch. */
  isMerged(repoPath: string, branch: string): boolean {
    const defaultBr = this.defaultBranch(repoPath)
    const result = execSync("git", ["-C", repoPath, "branch", "--contains", `refs/heads/${branch}`])
    if (!result.success) return false

    // Check if default branch is in the output
    const branches = result.stdout.split("\n").map((line) => line.replace(/^\*?\s+/, "").trim())
    return branches.includes(defaultBr)
  }

  /** Count unpushed commits on a branch (compared to origin). */
  unpushedCommits(repoPath: string, branch: string): number {
    const result = execSync("git", [
      "-C",
      repoPath,
      "rev-list",
      `origin/${branch}..refs/heads/${branch}`,
      "--count",
    ])
    if (!result.success) return 0
    return Number.parseInt(result.stdout, 10) || 0
  }

  /** Delete a branch. */
  deleteBranch(repoPath: string, branch: string, force = false): void {
    const flag = force ? "-D" : "-d"
    const result = execSync("git", ["-C", repoPath, "branch", flag, branch])
    if (!result.success) {
      throw new Error(`git branch ${flag} ${branch} failed: ${result.stderr}`)
    }
  }

  // --- Async methods for non-blocking operations ---

  /** List all worktrees for a repository (async). */
  async worktreeListAsync(repoPath: string): Promise<WorktreeInfo[]> {
    const result = await exec("git", ["-C", repoPath, "worktree", "list", "--porcelain"])
    if (!result.success) {
      throw new Error(`git worktree list failed: ${result.stderr}`)
    }
    return parseWorktreeList(result.stdout)
  }

  /** Add a new worktree (async). */
  async worktreeAddAsync(repoPath: string, opts: AddOptions): Promise<void> {
    const args = ["-C", repoPath, "worktree", "add"]

    if (opts.newBranch) {
      args.push("-b", opts.branch, opts.path)
      if (opts.baseBranch) {
        args.push(opts.baseBranch)
      }
    } else {
      args.push(opts.path, opts.branch)
    }

    const result = await exec("git", args)
    if (!result.success) {
      throw new Error(`git worktree add failed: ${result.stderr}`)
    }
  }

  /** Remove a worktree by path (async). */
  async worktreeRemoveAsync(repoPath: string, worktreePath: string): Promise<void> {
    const result = await exec("git", ["-C", repoPath, "worktree", "remove", worktreePath])
    if (!result.success) {
      throw new Error(`git worktree remove failed: ${result.stderr}`)
    }
  }

  /** Force-remove a worktree by path (async). */
  async worktreeRemoveForceAsync(repoPath: string, worktreePath: string): Promise<void> {
    const result = await exec("git", [
      "-C",
      repoPath,
      "worktree",
      "remove",
      "--force",
      worktreePath,
    ])
    if (!result.success) {
      throw new Error(`git worktree remove --force failed: ${result.stderr}`)
    }
  }

  /** Prune stale worktree entries (async). */
  async worktreePruneAsync(repoPath: string): Promise<void> {
    const result = await exec("git", ["-C", repoPath, "worktree", "prune"])
    if (!result.success) {
      throw new Error(`git worktree prune failed: ${result.stderr}`)
    }
  }

  /** Check if a branch exists in the repository (async). */
  async branchExistsAsync(repoPath: string, branch: string): Promise<boolean> {
    const result = await exec("git", [
      "-C",
      repoPath,
      "rev-parse",
      "--verify",
      `refs/heads/${branch}`,
    ])
    return result.success
  }

  /** Get comprehensive information about a branch (async). */
  async getBranchInfoAsync(repoPath: string, branch: string): Promise<BranchInfo> {
    const info: BranchInfo = {
      name: branch,
      exists: false,
      hasCommits: false,
      commitCount: 0,
      isMerged: false,
      upstream: "",
      lastCommit: null,
    }

    if (!(await this.branchExistsAsync(repoPath, branch))) {
      return info
    }
    info.exists = true

    const countResult = await exec("git", [
      "-C",
      repoPath,
      "rev-list",
      "--count",
      `refs/heads/${branch}`,
    ])
    if (countResult.success) {
      info.commitCount = Number.parseInt(countResult.stdout, 10) || 0
      info.hasCommits = info.commitCount > 0
    }

    const upstreamResult = await exec("git", [
      "-C",
      repoPath,
      "rev-parse",
      "--abbrev-ref",
      `${branch}@{upstream}`,
    ])
    if (upstreamResult.success) {
      info.upstream = upstreamResult.stdout.trim()
    }

    const logResult = await exec("git", [
      "-C",
      repoPath,
      "log",
      "-1",
      "--pretty=format:%H|%s|%an|%ad",
      "--date=iso",
      `refs/heads/${branch}`,
    ])
    if (logResult.success && logResult.stdout) {
      const commits = parseCommits(logResult.stdout)
      if (commits.length > 0) {
        info.lastCommit = commits[0]
      }
    }

    info.isMerged = await this.isMergedAsync(repoPath, branch)

    return info
  }

  /** Check if a branch is merged into the default branch (async). */
  async isMergedAsync(repoPath: string, branch: string): Promise<boolean> {
    const defaultBr = this.defaultBranch(repoPath)
    const result = await exec("git", [
      "-C",
      repoPath,
      "branch",
      "--contains",
      `refs/heads/${branch}`,
    ])
    if (!result.success) return false

    const branches = result.stdout.split("\n").map((line) => line.replace(/^\*?\s+/, "").trim())
    return branches.includes(defaultBr)
  }

  /** Delete a branch (async). */
  async deleteBranchAsync(repoPath: string, branch: string, force = false): Promise<void> {
    const flag = force ? "-D" : "-d"
    const result = await exec("git", ["-C", repoPath, "branch", flag, branch])
    if (!result.success) {
      throw new Error(`git branch ${flag} ${branch} failed: ${result.stderr}`)
    }
  }
}
