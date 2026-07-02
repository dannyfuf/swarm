/**
 * Status computation service for Swarm TUI.
 *
 * Computes worktree health status (changes, unpushed, merged, orphaned)
 * with TTL-based caching. All git work runs asynchronously so the UI never
 * blocks, and a single porcelain-v2 invocation per worktree answers both
 * the dirty and unpushed questions.
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

/** Callback fired as each worktree status finishes computing. */
export type StatusListener = (path: string, status: Status) => void

export class StatusService {
  private readonly cache = new Map<string, Status>()
  private readonly inFlight = new Map<string, Promise<Status>>()
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

  /**
   * Compute status for a single worktree, using cache when fresh.
   * Concurrent calls for the same path share one in-flight computation.
   */
  compute(wt: Worktree, opts: ComputeOptions): Promise<Status> {
    const cached = this.cache.get(wt.path)
    if (cached && this.isFresh(cached)) {
      return Promise.resolve(cached)
    }

    const inFlight = this.inFlight.get(wt.path)
    if (inFlight) {
      return inFlight
    }

    const promise = this.computeFresh(wt, opts).finally(() => {
      this.inFlight.delete(wt.path)
    })
    this.inFlight.set(wt.path, promise)
    return promise
  }

  /**
   * Compute statuses for multiple worktrees concurrently.
   * Git subprocesses are the bottleneck, so a small worker pool keeps
   * the machine responsive while saturating disk/CPU. Each result is
   * reported through `onStatus` as soon as it lands, so the UI can
   * paint badges incrementally instead of waiting for the whole batch.
   */
  async computeAll(
    items: WorktreeWithOptions[],
    onStatus?: StatusListener,
  ): Promise<Map<string, Status>> {
    const results = new Map<string, Status>()
    if (items.length === 0) return results

    const workerCount = Math.min(items.length, Math.max(cpus().length, 4), 8)
    let nextIndex = 0

    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex++
        if (index >= items.length) return
        const item = items[index]
        const status = await this.compute(item.worktree, item.options)
        results.set(item.worktree.path, status)
        onStatus?.(item.worktree.path, status)
      }
    })

    await Promise.all(workers)
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

  private async computeFresh(wt: Worktree, opts: ComputeOptions): Promise<Status> {
    const status: Status = {
      hasChanges: false,
      hasUnpushed: false,
      branchMerged: null,
      isOrphaned: wt.isOrphaned,
      computedAt: new Date(),
    }

    // One git call covers both dirty state and upstream ahead count
    try {
      const gitStatus = await this.git.worktreeStatusAsync(wt.path)
      status.hasChanges =
        gitStatus.modified.length > 0 ||
        gitStatus.added.length > 0 ||
        gitStatus.deleted.length > 0 ||
        gitStatus.untracked.length > 0
      status.hasUnpushed = gitStatus.hasUpstream && gitStatus.ahead > 0
    } catch {
      // Can't check status (dir might not exist)
    }

    // Check merge status (only if TTL is long enough to justify the cost)
    if (this.ttl >= 5 * 60_000) {
      try {
        status.branchMerged = await this.git.isMergedAsync(opts.repoPath, wt.branch)
      } catch {
        // Can't check merge status
      }
    }

    this.cache.set(wt.path, status)

    return status
  }

  private isFresh(status: Status): boolean {
    return Date.now() - status.computedAt.getTime() < this.ttl
  }
}
