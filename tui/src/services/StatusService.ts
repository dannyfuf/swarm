/**
 * Status computation service for Swarm TUI.
 *
 * Computes worktree health status (changes, unpushed, merged, orphaned)
 * with TTL-based caching. Supports parallel computation via worker pool.
 *
 * Ports the Go `internal/status/computer.go`.
 */

import { cpus } from "node:os"
import type { Status } from "../types/status.js"
import type { Worktree } from "../types/worktree.js"
import type { GitService } from "./GitService.js"

/** Options for computing a single worktree status. */
export interface ComputeOptions {
  repoPath: string
  defaultBranch: string
}

/** A worktree bundled with its compute options (for batch computation). */
export interface WorktreeWithOptions {
  worktree: Worktree
  options: ComputeOptions
}

export class StatusService {
  private readonly cache = new Map<string, Status>()
  private readonly ttl: number

  /**
   * @param git - Git service for status queries.
   * @param ttl - Cache TTL in milliseconds (default 30s).
   */
  constructor(
    private readonly git: GitService,
    ttl = 30_000,
  ) {
    this.ttl = ttl
  }

  /** Compute status for a single worktree, using cache when fresh. */
  compute(wt: Worktree, opts: ComputeOptions): Status {
    // Check cache
    const cached = this.cache.get(wt.path)
    if (cached && this.isFresh(cached)) {
      return cached
    }

    const status: Status = {
      hasChanges: false,
      hasUnpushed: false,
      branchMerged: null,
      isOrphaned: wt.isOrphaned,
      computedAt: new Date(),
    }

    // Check git status for changes
    try {
      const gitStatus = this.git.status(wt.path)
      status.hasChanges =
        gitStatus.modified.length > 0 ||
        gitStatus.added.length > 0 ||
        gitStatus.deleted.length > 0 ||
        gitStatus.untracked.length > 0
    } catch {
      // Can't check status (dir might not exist)
    }

    // Check unpushed commits
    try {
      const unpushed = this.git.unpushedCommits(wt.path, wt.branch)
      status.hasUnpushed = unpushed > 0
    } catch {
      // Can't check unpushed (no remote tracking)
    }

    // Check merge status (only if TTL is long enough to justify the cost)
    if (this.ttl >= 5 * 60_000) {
      try {
        status.branchMerged = this.git.isMerged(opts.repoPath, wt.branch)
      } catch {
        // Can't check merge status
      }
    }

    // Update cache
    this.cache.set(wt.path, status)

    return status
  }

  /**
   * Compute statuses for multiple worktrees in parallel.
   * Uses a worker pool with min(numCPUs, 4) concurrent workers.
   */
  async computeAll(items: WorktreeWithOptions[]): Promise<Map<string, Status>> {
    const results = new Map<string, Status>()
    const maxWorkers = Math.min(cpus().length, 4)

    // For simplicity and Bun compatibility, we process in batches
    // rather than using actual worker threads (git commands are the bottleneck)
    const batches = this.chunk(items, maxWorkers)

    for (const batch of batches) {
      // Process each batch concurrently
      const promises = batch.map(async (item) => {
        const status = this.compute(item.worktree, item.options)
        return { path: item.worktree.path, status }
      })

      const batchResults = await Promise.all(promises)
      for (const { path, status } of batchResults) {
        results.set(path, status)
      }
    }

    return results
  }

  /** Invalidate the cache entry for a specific worktree path. */
  invalidateCache(path: string): void {
    this.cache.delete(path)
  }

  /** Clear all cached statuses. */
  clearCache(): void {
    this.cache.clear()
  }

  private isFresh(status: Status): boolean {
    return Date.now() - status.computedAt.getTime() < this.ttl
  }

  private chunk<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size))
    }
    return chunks
  }
}
