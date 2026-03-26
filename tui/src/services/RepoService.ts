/**
 * Repository discovery service for Swarm TUI.
 *
 * Scans the AI working directory for git repositories, skipping
 * worktree directories (identified by `__wt__` in the name).
 *
 * Ports the Go `internal/repo/discovery.go`.
 */

import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Config } from "../types/config.js"
import type { Repo } from "../types/repo.js"
import type { GitService } from "./GitService.js"

export class RepoService {
  constructor(
    private readonly config: Config,
    private readonly git: GitService,
  ) {}

  /**
   * Scan the AI working directory for all git repositories.
   * Skips directories containing `__wt__` (worktree directories).
   */
  scanAll(): Repo[] {
    const aiDir = this.config.aiWorkingDir

    if (!existsSync(aiDir)) {
      throw new Error(`AI working directory does not exist: ${aiDir}`)
    }

    const entries = readdirSync(aiDir)
    const repos: Repo[] = []

    for (const entry of entries) {
      // Skip worktree directories
      if (entry.includes("__wt__")) continue

      const fullPath = join(aiDir, entry)

      // Must be a directory
      try {
        const stat = statSync(fullPath)
        if (!stat.isDirectory()) continue
      } catch {
        continue
      }

      // Must contain a .git directory (is a git repo)
      const gitDir = join(fullPath, ".git")
      if (!existsSync(gitDir)) continue

      // Detect default branch
      let defaultBranch: string
      try {
        defaultBranch = this.git.defaultBranch(fullPath)
      } catch {
        defaultBranch = this.config.defaultBaseBranch
      }

      repos.push({
        name: entry,
        path: fullPath,
        defaultBranch,
        lastScanned: new Date(),
      })
    }

    // Sort alphabetically by name
    repos.sort((a, b) => a.name.localeCompare(b.name))

    return repos
  }

  /** Find a repo by name with a direct path lookup. */
  findByName(name: string): Repo | null {
    const fullPath = join(this.config.aiWorkingDir, name)

    if (!existsSync(fullPath)) return null

    const gitDir = join(fullPath, ".git")
    if (!existsSync(gitDir)) return null

    let defaultBranch: string
    try {
      defaultBranch = this.git.defaultBranch(fullPath)
    } catch {
      defaultBranch = this.config.defaultBaseBranch
    }

    return {
      name,
      path: fullPath,
      defaultBranch,
      lastScanned: new Date(),
    }
  }
}
