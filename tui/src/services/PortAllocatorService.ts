/**
 * Allocates stable host ports for worktree containers.
 */

import { createServer } from "node:net"
import type { Config } from "../types/config.js"
import type { Repo } from "../types/repo.js"
import type { Worktree } from "../types/worktree.js"
import type { StateService } from "./StateService.js"

export class PortAllocatorService {
  constructor(
    private readonly config: Config,
    private readonly state: StateService,
  ) {}

  async allocate(_repo: Repo, worktree: Worktree): Promise<number> {
    if (worktree.container?.primaryHostPort) {
      return worktree.container.primaryHostPort
    }

    const state = await this.state.load()
    const usedPorts = new Set<number>()

    for (const repoState of Object.values(state.repos)) {
      for (const worktreeState of Object.values(repoState.worktrees)) {
        if (worktreeState.container?.primaryHostPort) {
          usedPorts.add(worktreeState.container.primaryHostPort)
        }
      }
    }

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
