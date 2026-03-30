/**
 * Allocates stable host ports for worktree compose environments.
 */

import { createServer } from "node:net"
import type { Config } from "../types/config.js"
import type { Repo } from "../types/repo.js"
import type { Worktree } from "../types/worktree.js"
import type { StateService } from "./StateService.js"

interface PortRequest {
  key: string
  requestedPublishedPort: number | null
}

export class PortAllocatorService {
  constructor(
    private readonly config: Config,
    private readonly state: StateService,
  ) {}

  async allocate(repo: Repo, worktree: Worktree): Promise<number> {
    if (typeof worktree.container?.primaryHostPort === "number") {
      return worktree.container.primaryHostPort
    }

    const ports = await this.allocatePublishedPorts(repo, worktree, [
      { key: "primary", requestedPublishedPort: null },
    ])
    const primaryPort = ports.primary
    if (typeof primaryPort !== "number") {
      throw new Error("Failed to allocate a primary host port.")
    }
    return primaryPort
  }

  async allocatePublishedPorts(
    _repo: Repo,
    worktree: Worktree,
    portRequests: PortRequest[],
  ): Promise<Record<string, number>> {
    const existingPorts: Record<string, number> = {
      ...(typeof worktree.container?.primaryHostPort === "number"
        ? { primary: worktree.container.primaryHostPort }
        : {}),
      ...(worktree.container?.publishedPorts ?? {}),
    }
    const allocations: Record<string, number> = {}

    const usedPorts = await this.collectUsedPorts(worktree)

    for (const request of portRequests) {
      const key = request.key
      const existingPort = existingPorts[key]

      if (typeof request.requestedPublishedPort === "number") {
        const requestedPort = request.requestedPublishedPort

        if (existingPort === requestedPort) {
          allocations[key] = requestedPort
          usedPorts.add(requestedPort)
          continue
        }

        if (usedPorts.has(requestedPort) || !(await isPortAvailable(requestedPort))) {
          throw new Error(`Requested host port ${requestedPort} for ${key} is unavailable.`)
        }

        allocations[key] = requestedPort
        usedPorts.add(requestedPort)
        continue
      }

      if (typeof existingPort === "number") {
        allocations[key] = existingPort
        usedPorts.add(existingPort)
        continue
      }

      allocations[key] = await this.findAvailablePort(usedPorts)
      usedPorts.add(allocations[key])
    }

    return allocations
  }

  private async collectUsedPorts(worktree: Worktree): Promise<Set<number>> {
    const state = await this.state.load()
    const usedPorts = new Set<number>()

    for (const repoState of Object.values(state.repos)) {
      for (const worktreeState of Object.values(repoState.worktrees)) {
        if (worktreeState.path === worktree.path) continue

        const publishedPorts: Record<string, number> = {
          ...(typeof worktreeState.container?.primaryHostPort === "number"
            ? { primary: worktreeState.container.primaryHostPort }
            : {}),
          ...(worktreeState.container?.publishedPorts ?? {}),
        }

        for (const port of Object.values(publishedPorts)) {
          usedPorts.add(port)
        }
      }
    }

    return usedPorts
  }

  private async findAvailablePort(usedPorts: Set<number>): Promise<number> {
    for (
      let port = this.config.containerPortRangeStart;
      port <= this.config.containerPortRangeEnd;
      port += 1
    ) {
      if (usedPorts.has(port)) continue
      if (await isPortAvailable(port)) {
        return port
      }
    }

    throw new Error(
      `No available container host ports in range ${this.config.containerPortRangeStart}-${this.config.containerPortRangeEnd}. Stop/delete environments or widen the configured range.`,
    )
  }
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()

    server.once("error", () => {
      resolve(false)
    })

    server.once("listening", () => {
      server.close(() => resolve(true))
    })

    server.listen(port, "127.0.0.1")
  })
}
