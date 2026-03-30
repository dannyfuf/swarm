/**
 * Worktree CRUD service for Swarm TUI.
 *
 * Manages the lifecycle of git worktrees: creation, listing, and removal.
 * Cross-references git worktree data with persisted state for full metadata.
 *
 * Ports the Go `internal/worktree/manager.go` and `internal/worktree/orphan.go`.
 */

import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { Config } from "../types/config.js"
import type { WorktreeContainerMetadata } from "../types/container.js"
import type { Repo } from "../types/repo.js"
import type { WorktreeState } from "../types/state.js"
import type { CreateOptions, OrphanedWorktree, Worktree } from "../types/worktree.js"
import { generateSlug, generateUniqueSlug } from "../utils/slug.js"
import type { GitService } from "./GitService.js"
import type { StateService } from "./StateService.js"

/** Session naming convention: `<repo>--wt--<slug>` */
function buildSessionName(repoName: string, slug: string): string {
  return `${repoName}--wt--${slug}`
}

export class WorktreeService {
  constructor(
    private readonly config: Config,
    private readonly git: GitService,
    private readonly state: StateService,
  ) {}

  /** Create a new worktree for the given repo. */
  async create(repo: Repo, opts: CreateOptions): Promise<Worktree> {
    // Build existing slug map from state
    const existingWorktrees = await this.state.getRepoWorktrees(repo.name)
    const slugMap = new Map<string, string>()
    for (const wt of Object.values(existingWorktrees)) {
      slugMap.set(wt.slug, wt.branch)
    }

    // Generate unique slug
    const slug = generateUniqueSlug(opts.branch, slugMap)

    // Resolve worktree path based on pattern
    const worktreePath = this.resolveWorktreePath(repo, slug)

    // Add worktree via git
    await this.git.worktreeAddAsync(repo.path, {
      path: worktreePath,
      branch: opts.branch,
      baseBranch: opts.baseBranch,
      newBranch: opts.newBranch,
    })

    // Build worktree metadata
    const now = new Date()
    const sessionName = buildSessionName(repo.name, slug)

    const worktreeState: WorktreeState = {
      slug,
      branch: opts.branch,
      path: worktreePath,
      createdAt: now,
      lastOpenedAt: now,
      tmuxSession: sessionName,
      container: undefined,
    }

    // Persist to state
    await this.state.updateWorktree(repo.name, repo.path, repo.defaultBranch, worktreeState)

    return {
      slug,
      branch: opts.branch,
      path: worktreePath,
      repoName: repo.name,
      createdAt: now,
      lastOpenedAt: now,
      tmuxSession: sessionName,
      container: undefined,
      isOrphaned: false,
    }
  }

  /** List all worktrees for a repo, cross-referencing git and state data. */
  async list(repo: Repo): Promise<Worktree[]> {
    // Get git worktree list
    const gitWorktrees = this.git.worktreeList(repo.path)

    // Get state data
    const stateWorktrees = await this.state.getRepoWorktrees(repo.name)

    const worktrees: Worktree[] = []

    // Build a set of git worktree paths for orphan detection
    const gitPaths = new Set(gitWorktrees.map((wt) => wt.path))

    for (const gitWt of gitWorktrees) {
      // Skip the main repo worktree (it's the repo itself)
      if (gitWt.path === repo.path) continue

      // Skip stale/prunable entries - these are git admin artifacts from deleted directories
      if (gitWt.prunable) continue

      // Skip entries whose directories no longer exist on disk
      if (!existsSync(gitWt.path)) continue

      // Find matching state entry by path
      const stateEntry = Object.values(stateWorktrees).find((s) => s.path === gitWt.path)

      const branch = gitWt.branch || stateEntry?.branch || ""
      const slug = stateEntry?.slug || generateSlug(branch)
      const sessionName = stateEntry?.tmuxSession || buildSessionName(repo.name, slug)

      worktrees.push({
        slug,
        branch,
        path: gitWt.path,
        repoName: repo.name,
        createdAt: stateEntry?.createdAt ?? new Date(),
        lastOpenedAt: stateEntry?.lastOpenedAt ?? new Date(),
        tmuxSession: sessionName,
        container: stateEntry?.container,
        isOrphaned: false,
      })
    }

    // Also add state entries whose paths are NOT in git (orphaned)
    for (const stateEntry of Object.values(stateWorktrees)) {
      if (!gitPaths.has(stateEntry.path)) {
        worktrees.push({
          slug: stateEntry.slug,
          branch: stateEntry.branch,
          path: stateEntry.path,
          repoName: repo.name,
          createdAt: stateEntry.createdAt,
          lastOpenedAt: stateEntry.lastOpenedAt,
          tmuxSession: stateEntry.tmuxSession,
          container: stateEntry.container,
          isOrphaned: true,
        })
      }
    }

    return worktrees
  }

  /** Remove a worktree (git + filesystem + state). */
  async remove(repo: Repo, wt: Worktree, force = false): Promise<void> {
    // Safety: never allow deleting the main repo
    if (wt.path === repo.path) {
      throw new Error("Cannot delete the main repository worktree")
    }

    // Remove from git (continue on error if force)
    let gitRemoveSucceeded = false
    try {
      if (force) {
        await this.git.worktreeRemoveForceAsync(repo.path, wt.path)
      } else {
        await this.git.worktreeRemoveAsync(repo.path, wt.path)
      }
      gitRemoveSucceeded = true
    } catch (error) {
      if (!force) throw error
      // Force mode: continue even if git removal fails
    }

    // Verify the worktree is no longer in git's list
    if (gitRemoveSucceeded) {
      const remainingGitWorktrees = await this.git.worktreeListAsync(repo.path)
      const stillInGitList = remainingGitWorktrees.some((gwt) => gwt.path === wt.path)
      if (stillInGitList) {
        throw new Error(`Worktree still appears in git list after removal: ${wt.path}`)
      }
    }

    // If directory still exists, remove it explicitly
    if (existsSync(wt.path)) {
      try {
        rmSync(wt.path, { recursive: true, force: true })
      } catch (error) {
        throw new Error(
          `Failed to remove worktree directory ${wt.path}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    // Remove from state (do this last so failures can be retried)
    await this.state.removeWorktree(repo.name, wt.slug)

    // Auto-prune if configured
    if (this.config.autoPruneOnRemove) {
      try {
        await this.git.worktreePruneAsync(repo.path)
      } catch {
        // Ignore prune errors
      }
    }
  }

  /** Update the lastOpenedAt timestamp for a worktree. */
  async updateLastOpened(repo: Repo, wt: Worktree): Promise<void> {
    const worktreeState: WorktreeState = {
      slug: wt.slug,
      branch: wt.branch,
      path: wt.path,
      createdAt: wt.createdAt,
      lastOpenedAt: new Date(),
      tmuxSession: wt.tmuxSession,
      container: wt.container,
    }

    await this.state.updateWorktree(repo.name, repo.path, repo.defaultBranch, worktreeState)
  }

  /** Update persisted container metadata for a worktree. */
  async updateContainerMetadata(
    repo: Repo,
    wt: Worktree,
    container: WorktreeContainerMetadata | undefined,
  ): Promise<void> {
    await this.state.updateWorktreeContainer(repo.name, wt.slug, container)
  }

  /** Detect orphaned worktrees (in state but not in git). */
  async detectOrphans(repo: Repo): Promise<OrphanedWorktree[]> {
    const gitWorktrees = this.git.worktreeList(repo.path)
    const gitPaths = new Set(gitWorktrees.map((wt) => wt.path))

    const stateWorktrees = await this.state.getRepoWorktrees(repo.name)
    const orphans: OrphanedWorktree[] = []

    for (const stateEntry of Object.values(stateWorktrees)) {
      if (!gitPaths.has(stateEntry.path)) {
        orphans.push({
          slug: stateEntry.slug,
          branch: stateEntry.branch,
          path: stateEntry.path,
          reason: "Worktree exists in state but not in git",
          createdAt: stateEntry.createdAt,
        })
      }
    }

    return orphans
  }

  /** Clean orphaned entries from state. */
  async cleanOrphans(repo: Repo, orphans: OrphanedWorktree[]): Promise<void> {
    for (const orphan of orphans) {
      await this.state.removeWorktree(repo.name, orphan.slug)
    }
  }

  /**
   * Resolve the filesystem path for a new worktree based on the
   * configured pattern.
   */
  private resolveWorktreePath(repo: Repo, slug: string): string {
    switch (this.config.worktreePattern) {
      case "patternA":
        // Flat sibling: <aiWorkingDir>/<repo>__wt__<slug>
        return join(this.config.aiWorkingDir, `${repo.name}__wt__${slug}`)
      case "patternB":
        // Nested in repo: <repoPath>/.worktrees/<slug>
        return join(repo.path, ".worktrees", slug)
      case "patternC":
        // Centralized: <aiWorkingDir>/.worktrees/<repo>/<slug>
        return join(this.config.aiWorkingDir, ".worktrees", repo.name, slug)
      default:
        return join(this.config.aiWorkingDir, `${repo.name}__wt__${slug}`)
    }
  }
}
