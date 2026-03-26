/**
 * State persistence service for Swarm TUI.
 *
 * Manages `.swarm-state.json` with file locking (proper-lockfile) and
 * atomic writes (write tmp + rename). The JSON format is backward-compatible
 * with the Go implementation.
 *
 * Ports the Go `internal/state/store.go`.
 */

import { readFile, rename, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import lockfile from "proper-lockfile"
import type { RepoState, State, WorktreeState } from "../types/state.js"

const STATE_FILENAME = ".swarm-state.json"
const STATE_VERSION = 1

export class StateService {
  private readonly statePath: string

  constructor(aiWorkingDir: string) {
    this.statePath = join(aiWorkingDir, STATE_FILENAME)
  }

  /** Load state from disk, returning empty state if file doesn't exist. */
  async load(): Promise<State> {
    try {
      const content = await readFile(this.statePath, "utf-8")
      return this.deserialize(content)
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return this.emptyState()
      }
      throw new Error(`Failed to load state: ${error}`)
    }
  }

  /** Save state to disk with file locking and atomic write. */
  async save(state: State): Promise<void> {
    state.updatedAt = new Date()
    state.version = STATE_VERSION

    const tmpPath = `${this.statePath}.tmp`
    const content = this.serialize(state)

    // Ensure parent directory exists
    const dir = this.statePath.slice(0, this.statePath.lastIndexOf("/"))
    await Bun.write(`${dir}/.keep`, "")

    let release: (() => Promise<void>) | null = null
    try {
      // Acquire file lock (creates lockfile if state file doesn't exist yet)
      try {
        release = await lockfile.lock(this.statePath, {
          realpath: false,
          retries: { retries: 3, minTimeout: 100, maxTimeout: 1000 },
        })
      } catch {
        // If the state file doesn't exist yet, create it first then lock
        await writeFile(this.statePath, "{}", "utf-8")
        release = await lockfile.lock(this.statePath, {
          realpath: false,
          retries: { retries: 3, minTimeout: 100, maxTimeout: 1000 },
        })
      }

      // Atomic write: write to tmp, then rename
      await writeFile(tmpPath, content, "utf-8")
      await rename(tmpPath, this.statePath)
    } catch (error) {
      // Clean up tmp file on failure
      try {
        await unlink(tmpPath)
      } catch {
        // Ignore cleanup errors
      }
      throw new Error(`Failed to save state: ${error}`)
    } finally {
      if (release) {
        await release()
      }
    }
  }

  /** Update a single worktree entry (read-modify-write with lock). */
  async updateWorktree(
    repoName: string,
    repoPath: string,
    defaultBranch: string,
    worktreeState: WorktreeState,
  ): Promise<void> {
    const state = await this.load()

    if (!state.repos[repoName]) {
      state.repos[repoName] = {
        path: repoPath,
        defaultBranch,
        lastScanned: new Date(),
        worktrees: {},
      }
    }

    state.repos[repoName].worktrees[worktreeState.slug] = worktreeState
    await this.save(state)
  }

  /** Remove a worktree entry from state. */
  async removeWorktree(repoName: string, slug: string): Promise<void> {
    const state = await this.load()

    const repoState = state.repos[repoName]
    if (!repoState) return

    delete repoState.worktrees[slug]
    await this.save(state)
  }

  /** Get worktree states for a specific repo. */
  async getRepoWorktrees(repoName: string): Promise<Record<string, WorktreeState>> {
    const state = await this.load()
    return state.repos[repoName]?.worktrees ?? {}
  }

  /** Get the full repo state entry. */
  async getRepoState(repoName: string): Promise<RepoState | null> {
    const state = await this.load()
    return state.repos[repoName] ?? null
  }

  private emptyState(): State {
    return {
      version: STATE_VERSION,
      updatedAt: new Date(),
      repos: {},
    }
  }

  private serialize(state: State): string {
    return JSON.stringify(state, null, 2)
  }

  private deserialize(content: string): State {
    const raw = JSON.parse(content)

    // Reconstitute Date objects from JSON strings
    if (raw.updatedAt) {
      raw.updatedAt = new Date(raw.updatedAt)
    }

    for (const repoState of Object.values(raw.repos ?? {}) as RepoState[]) {
      if (repoState.lastScanned) {
        repoState.lastScanned = new Date(repoState.lastScanned as unknown as string)
      }
      for (const wt of Object.values(repoState.worktrees ?? {}) as WorktreeState[]) {
        if (wt.createdAt) {
          wt.createdAt = new Date(wt.createdAt as unknown as string)
        }
        if (wt.lastOpenedAt) {
          wt.lastOpenedAt = new Date(wt.lastOpenedAt as unknown as string)
        }
      }
    }

    return raw as State
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
