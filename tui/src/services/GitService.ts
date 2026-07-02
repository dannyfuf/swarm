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

import type {
  AddOptions,
  BranchInfo,
  StatusResult,
  WorktreeInfo,
  WorktreeStatus,
} from "../types/git.js"
import { parseCommits, parseStatus, parseStatusV2, parseWorktreeList } from "../utils/git-parser.js"
import { exec, execSync } from "../utils/shell.js"

export class GitService {
  /**
   * The default branch of a repo never changes mid-session, so cache it:
   * detecting it costs up to three git invocations per lookup.
   */
  private readonly defaultBranchCache = new Map<string, string>()

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
    const cached = this.defaultBranchCache.get(repoPath)
    if (cached) return cached

    let branch = "main" // Ultimate fallback

    // Try origin/HEAD
    const symRef = execSync("git", ["-C", repoPath, "symbolic-ref", "refs/remotes/origin/HEAD"])
    if (symRef.success && symRef.stdout.replace(/^refs\/remotes\/origin\//, "")) {
      // refs/remotes/origin/main -> main
      branch = symRef.stdout.replace(/^refs\/remotes\/origin\//, "")
    } else if (
      execSync("git", ["-C", repoPath, "rev-parse", "--verify", "refs/heads/main"]).success
    ) {
      branch = "main"
    } else if (
      execSync("git", ["-C", repoPath, "rev-parse", "--verify", "refs/heads/master"]).success
    ) {
      branch = "master"
    }

    this.defaultBranchCache.set(repoPath, branch)
    return branch
  }

  /** Detect the default branch for a repository (async, cached). */
  async defaultBranchAsync(repoPath: string): Promise<string> {
    const cached = this.defaultBranchCache.get(repoPath)
    if (cached) return cached

    let branch = "main" // Ultimate fallback

    const symRef = await exec("git", ["-C", repoPath, "symbolic-ref", "refs/remotes/origin/HEAD"])
    if (symRef.success && symRef.stdout.replace(/^refs\/remotes\/origin\//, "")) {
      branch = symRef.stdout.replace(/^refs\/remotes\/origin\//, "")
    } else if (
      (await exec("git", ["-C", repoPath, "rev-parse", "--verify", "refs/heads/main"])).success
    ) {
      branch = "main"
    } else if (
      (await exec("git", ["-C", repoPath, "rev-parse", "--verify", "refs/heads/master"])).success
    ) {
      branch = "master"
    }

    this.defaultBranchCache.set(repoPath, branch)
    return branch
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

  /**
   * Check if a branch is merged into the default branch.
   * Uses `merge-base --is-ancestor` (one ancestry walk) instead of
   * `branch --contains`, which scans every branch in the repository.
   */
  isMerged(repoPath: string, branch: string): boolean {
    const defaultBr = this.defaultBranch(repoPath)
    const result = execSync("git", [
      "-C",
      repoPath,
      "merge-base",
      "--is-ancestor",
      `refs/heads/${branch}`,
      `refs/heads/${defaultBr}`,
    ])
    return result.success
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

  /** Get working tree status (async, porcelain format). */
  async statusAsync(repoPath: string): Promise<StatusResult> {
    const result = await exec("git", [
      "-C",
      repoPath,
      "--no-optional-locks",
      "status",
      "--porcelain",
    ])
    if (!result.success) {
      throw new Error(`git status failed: ${result.stderr}`)
    }
    return parseStatus(result.stdout)
  }

  /**
   * Get working tree status plus upstream ahead/behind counts in a single
   * git invocation (async). `--no-optional-locks` avoids contending with
   * other git processes on the index in large repositories.
   */
  async worktreeStatusAsync(worktreePath: string): Promise<WorktreeStatus> {
    const result = await exec("git", [
      "-C",
      worktreePath,
      "--no-optional-locks",
      "status",
      "--porcelain=v2",
      "--branch",
    ])
    if (!result.success) {
      throw new Error(`git status failed: ${result.stderr}`)
    }
    return parseStatusV2(result.stdout)
  }

  /** Count unpushed commits on a branch compared to origin (async). */
  async unpushedCommitsAsync(repoPath: string, branch: string): Promise<number> {
    const result = await exec("git", [
      "-C",
      repoPath,
      "rev-list",
      `origin/${branch}..refs/heads/${branch}`,
      "--count",
    ])
    if (!result.success) return 0
    return Number.parseInt(result.stdout, 10) || 0
  }

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
    const defaultBr = await this.defaultBranchAsync(repoPath)
    const result = await exec("git", [
      "-C",
      repoPath,
      "merge-base",
      "--is-ancestor",
      `refs/heads/${branch}`,
      `refs/heads/${defaultBr}`,
    ])
    return result.success
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
