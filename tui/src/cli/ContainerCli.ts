/**
 * Directory-local CLI entrypoints for worktree container operations.
 */

import { BuildContainerImageCommand } from "../commands/BuildContainerImageCommand.js"
import { ContainerStatusCommand } from "../commands/ContainerStatusCommand.js"
import { EnsureContainerConfigCommand } from "../commands/EnsureContainerConfigCommand.js"
import { StartContainerCommand } from "../commands/StartContainerCommand.js"
import { StopContainerCommand } from "../commands/StopContainerCommand.js"
import type { Services } from "../state/AppContext.js"
import { parseContainerCliArgs } from "./parseArgs.js"
import { resolveContextFromCwd } from "./resolveContextFromCwd.js"

export async function runCli(args: string[], services: Services): Promise<number> {
  try {
    const parsed = parseContainerCliArgs(args)
    const context = await resolveContextFromCwd(process.cwd(), services)

    switch (parsed.action) {
      case "build": {
        const command = new BuildContainerImageCommand(
          services.containerConfig,
          services.containerBuild,
          services.containerRuntime,
          context.repo,
          context.worktree ?? undefined,
        )
        const result = await command.execute()
        if (!result.success) {
          const scaffold = result.data as { composeFilePath?: string } | undefined
          if (scaffold?.composeFilePath) {
            console.log(result.message)
            console.log(`path=${scaffold.composeFilePath}`)
            return 1
          }
          throw new Error(result.message)
        }
        console.log(result.message)
        const data = result.data as { warning?: string | null } | undefined
        if (data?.warning) {
          console.log(`warning=${data.warning}`)
        }
        return 0
      }
      case "init": {
        const command = new EnsureContainerConfigCommand(services.containerConfig, context.repo)
        const result = await command.execute()
        if (!result.success) {
          throw new Error(result.message)
        }
        const scaffold = result.data as { path: string }
        console.log(result.message)
        console.log(`path=${scaffold.path}`)
        console.log(`compose=${(result.data as { composeFilePath: string }).composeFilePath}`)
        return 0
      }
      case "up": {
        if (!context.worktree) {
          throw new Error("`swarm container up` must be run inside a worktree directory.")
        }
        const command = new StartContainerCommand(
          services.containerConfig,
          services.containerRuntime,
          services.worktree,
          context.repo,
          context.worktree,
        )
        const result = await command.execute()
        if (!result.success) {
          const scaffold = result.data as { composeFilePath?: string } | undefined
          if (scaffold?.composeFilePath) {
            console.log(result.message)
            console.log(`path=${scaffold.composeFilePath}`)
            return 1
          }
          throw new Error(result.message)
        }
        console.log(result.message)
        const data = result.data as { warning?: string | null } | undefined
        if (data?.warning) {
          console.log(`warning=${data.warning}`)
        }
        return 0
      }
      case "down": {
        if (!context.worktree) {
          throw new Error("`swarm container down` must be run inside a worktree directory.")
        }
        const command = new StopContainerCommand(
          services.containerRuntime,
          context.repo,
          context.worktree,
        )
        const result = await command.execute()
        if (!result.success) throw new Error(result.message)
        console.log(result.message)
        return 0
      }
      case "status": {
        if (!context.worktree) {
          throw new Error("`swarm container status` must be run inside a worktree directory.")
        }
        const command = new ContainerStatusCommand(
          services.containerRuntime,
          context.repo,
          context.worktree,
        )
        const result = await command.execute()
        if (!result.success) throw new Error(result.message)
        console.log(result.message)
        const status = result.data as {
          state: string
          health: string
          primaryUrl: string | null
          message: string
          warning: string | null
        }
        console.log(
          `health=${status.health} url=${status.primaryUrl ?? "n/a"} detail=${status.message}`,
        )
        if (status.warning) {
          console.log(`warning=${status.warning}`)
        }
        return 0
      }
      case "logs": {
        if (!context.worktree) {
          throw new Error("`swarm container logs` must be run inside a worktree directory.")
        }
        const output = await services.containerRuntime.logs(context.worktree)
        console.log(`== ${context.worktree.branch} container logs ==`)
        console.log(output)
        return 0
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unknown CLI error")
    return 1
  }
}
