/**
 * Safety checking service for Swarm TUI.
 *
 * Performs pre-removal checks on worktrees to identify blockers (prevent action)
 * and warnings (allow with confirmation). Also checks branch deletion safety.
 *
 * Ports the Go `internal/safety/checker.go` and `internal/safety/branch.go`.
 */

import { existsSync } from "node:fs"
import type {
  Blocker,
  BranchSafetyResult,
  CheckMetadata,
  CheckResult,
  Warning,
} from "../types/safety.js"
import type { Worktree } from "../types/worktree.js"
import type { GitService } from "./GitService.js"

export class SafetyService {
  constructor(private readonly git: GitService) {}

  /**
   * Check whether a worktree is safe to remove.
   * Returns blockers (uncommitted changes) and warnings (unpushed commits).
   */
  checkRemoval(wt: Worktree): CheckResult {
    const blockers: Blocker[] = []
    const warnings: Warning[] = []
    const metadata: CheckMetadata = {
      checkedAt: new Date(),
      uncommittedFiles: 0,
      unpushedCommits: 0,
      branchMerged: null,
    }

    // If the directory doesn't exist, it's a dangling entry -- safe to remove
    if (!existsSync(wt.path)) {
      return {
        safe: true,
        blockers,
        warnings,
        metadata,
      }
    }

    // Check for uncommitted changes
    try {
      const status = this.git.status(wt.path)
      const totalChanges =
        status.modified.length +
        status.added.length +
        status.deleted.length +
        status.untracked.length

      if (totalChanges > 0) {
        metadata.uncommittedFiles = totalChanges
        const details = this.formatChanges(status)

        blockers.push({
          type: "uncommitted_changes",
          message: `${totalChanges} uncommitted file(s)`,
          details,
          fix: "Commit or stash your changes before removing this worktree",
        })
      }
    } catch {
      // If status fails, assume there might be changes
      warnings.push({
        type: "orphaned_state",
        message: "Could not check git status",
        details: "Git status command failed for this worktree",
      })
    }

    // Check for unpushed commits
    try {
      const unpushed = this.git.unpushedCommits(wt.path, wt.branch)
      if (unpushed > 0) {
        metadata.unpushedCommits = unpushed
        warnings.push({
          type: "unpushed_commits",
          message: `${unpushed} unpushed commit(s)`,
          details: `Branch "${wt.branch}" has ${unpushed} commit(s) not pushed to origin`,
        })
      }
    } catch {
      // Ignore if we can't check unpushed (no remote tracking)
    }

    return {
      safe: blockers.length === 0 && warnings.length === 0,
      blockers,
      warnings,
      metadata,
    }
  }

  /** Check whether a branch is safe to delete. */
  checkBranchDeletion(repoPath: string, branch: string): BranchSafetyResult {
    const result: BranchSafetyResult = {
      safe: true,
      warnings: [],
      blockers: [],
      commitCount: 0,
      unpushedCount: 0,
      isMerged: false,
    }

    try {
      const branchInfo = this.git.getBranchInfo(repoPath, branch)

      if (!branchInfo.exists) {
        result.blockers.push(`Branch "${branch}" does not exist`)
        result.safe = false
        return result
      }

      result.commitCount = branchInfo.commitCount
      result.isMerged = branchInfo.isMerged

      // Check merge status
      if (!branchInfo.isMerged) {
        result.warnings.push(`Branch "${branch}" is not merged into the default branch`)
      }

      // Check unpushed commits
      const unpushed = this.git.unpushedCommits(repoPath, branch)
      result.unpushedCount = unpushed
      if (unpushed > 0) {
        result.warnings.push(`Branch "${branch}" has ${unpushed} unpushed commit(s)`)
      }

      result.safe = result.blockers.length === 0
    } catch (error) {
      result.blockers.push(
        `Failed to check branch: ${error instanceof Error ? error.message : String(error)}`,
      )
      result.safe = false
    }

    return result
  }

  /** Format a safety check result as a human-readable string. */
  formatResult(result: CheckResult, color = false): string {
    const lines: string[] = []

    if (result.blockers.length > 0) {
      lines.push(color ? "\x1b[31mBlockers:\x1b[0m" : "Blockers:")
      for (const blocker of result.blockers) {
        lines.push(`  ✗ ${blocker.message}`)
        if (blocker.details) lines.push(`    ${blocker.details}`)
        if (blocker.fix) lines.push(`    Fix: ${blocker.fix}`)
      }
    }

    if (result.warnings.length > 0) {
      lines.push(color ? "\x1b[33mWarnings:\x1b[0m" : "Warnings:")
      for (const warning of result.warnings) {
        lines.push(`  ⚠ ${warning.message}`)
        if (warning.details) lines.push(`    ${warning.details}`)
      }
    }

    if (result.safe) {
      lines.push(color ? "\x1b[32m✓ Safe to remove\x1b[0m" : "✓ Safe to remove")
    }

    return lines.join("\n")
  }

  private formatChanges(status: {
    modified: string[]
    added: string[]
    deleted: string[]
    untracked: string[]
  }): string {
    const parts: string[] = []
    if (status.modified.length > 0) {
      parts.push(`${status.modified.length} modified`)
    }
    if (status.added.length > 0) {
      parts.push(`${status.added.length} added`)
    }
    if (status.deleted.length > 0) {
      parts.push(`${status.deleted.length} deleted`)
    }
    if (status.untracked.length > 0) {
      parts.push(`${status.untracked.length} untracked`)
    }
    return parts.join(", ")
  }
}
