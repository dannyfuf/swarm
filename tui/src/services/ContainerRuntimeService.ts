/**
 * Manages Docker runtime lifecycle for worktree containers.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import type {
  ContainerBuildPlan,
  ContainerRuntimeStatus,
  StartContainerResult,
  WorktreeContainerMetadata,
} from "../types/container.js"
import type { Repo } from "../types/repo.js"
import type { Worktree } from "../types/worktree.js"
import type { AsyncCommandRunner } from "../utils/shell.js"
import { exec } from "../utils/shell.js"
import type { ContainerBuildService } from "./ContainerBuildService.js"
import type { PortAllocatorService } from "./PortAllocatorService.js"

const DATA_VOLUME_SUFFIXES = ["data", "cache"] as const

export class ContainerRuntimeService {
  constructor(
    private readonly containerBuildService: ContainerBuildService,
    private readonly portAllocatorService: PortAllocatorService,
    private readonly runCommand: AsyncCommandRunner = exec,
  ) {}

  async build(repo: Repo, worktree?: Worktree, force = false): Promise<ContainerBuildPlan> {
    return this.containerBuildService.buildForRepo(
      repo.path,
      worktree?.path ?? repo.path,
      worktree?.container,
      force,
    )
  }

  async start(repo: Repo, worktree: Worktree): Promise<StartContainerResult> {
    const plan = await this.containerBuildService.buildForRepo(
      repo.path,
      worktree.path,
      worktree.container,
    )
    const metadata = await this.resolveMetadata(repo, worktree, plan)

    await this.ensureNetwork(metadata.networkName)
    for (const volumeName of metadata.dataVolumeNames) {
      await this.ensureVolume(volumeName)
    }

    const existingStatus = await this.inspectContainer(metadata.containerName)
    if (existingStatus.state === "running") {
      return {
        metadata,
        status: { ...existingStatus, warning: plan.warning },
        warning: plan.warning,
      }
    }

    if (existingStatus.state !== "not-created") {
      await this.removeContainer(metadata.containerName)
    }

    const primaryProcess = plan.config.processes.find((process) => process.expose)
    if (!primaryProcess || primaryProcess.internalPort === null) {
      throw new Error("Container config does not define a valid exposed primary process.")
    }

    const args = [
      "run",
      "-d",
      "--name",
      metadata.containerName,
      "--network",
      metadata.networkName,
      "--label",
      `swarm.repo=${repo.name}`,
      "--label",
      `swarm.worktree=${worktree.slug}`,
      "-p",
      `${metadata.primaryHostPort}:${primaryProcess.internalPort}`,
      "-v",
      `${worktree.path}:/workspace`,
    ]

    for (const volumeName of metadata.dataVolumeNames) {
      args.push("-v", `${volumeName}:/var/lib/swarm/${volumeName.split("-").at(-1)}`)
    }

    const envFilePath = plan.config.env.file ? join(worktree.path, plan.config.env.file) : null
    if (envFilePath) {
      if (!existsSync(envFilePath)) {
        throw new Error(`Container env file not found: ${envFilePath}`)
      }
      args.push("--env-file", envFilePath)
    }

    for (const [key, value] of Object.entries(plan.config.env.vars)) {
      args.push("-e", `${key}=${value}`)
    }

    args.push(plan.dependencyImageTag)

    const result = await this.runCommand("docker", args)
    if (!result.success) {
      throw new Error(`Failed to start container: ${result.stderr || result.stdout}`)
    }

    return {
      metadata,
      status: await this.inspectContainer(
        metadata.containerName,
        metadata.primaryHostPort,
        plan.warning,
      ),
      warning: plan.warning,
    }
  }

  async stop(worktree: Worktree): Promise<ContainerRuntimeStatus> {
    if (!worktree.container) {
      throw new Error("No container metadata is stored for this worktree.")
    }

    const stopResult = await this.runCommand("docker", ["stop", worktree.container.containerName])
    if (!stopResult.success) {
      const message = stopResult.stderr || stopResult.stdout
      if (message.includes("No such container")) {
        return {
          state: "not-created",
          health: "none",
          primaryUrl: `http://127.0.0.1:${worktree.container.primaryHostPort}`,
          message: "Container not created",
          warning: null,
        }
      }
      throw new Error(`Failed to stop container: ${stopResult.stderr || stopResult.stdout}`)
    }

    return this.inspectContainer(
      worktree.container.containerName,
      worktree.container.primaryHostPort,
    )
  }

  async removeEnvironment(worktree: Worktree): Promise<void> {
    if (!worktree.container) return

    await this.removeContainer(worktree.container.containerName)
    const networkResult = await this.runCommand("docker", [
      "network",
      "rm",
      worktree.container.networkName,
    ])
    if (!networkResult.success) {
      const message = networkResult.stderr || networkResult.stdout
      if (!message.includes("No such network")) {
        throw new Error(`Failed to remove Docker network: ${message}`)
      }
    }

    for (const volumeName of worktree.container.dataVolumeNames) {
      const volumeResult = await this.runCommand("docker", ["volume", "rm", volumeName])
      if (!volumeResult.success) {
        const message = volumeResult.stderr || volumeResult.stdout
        if (!message.includes("No such volume")) {
          throw new Error(`Failed to remove Docker volume ${volumeName}: ${message}`)
        }
      }
    }
  }

  async getStatus(repo: Repo, worktree: Worktree): Promise<ContainerRuntimeStatus> {
    if (!worktree.container) {
      return {
        state: "not-created",
        health: "none",
        primaryUrl: null,
        message: "No environment created",
        warning: null,
      }
    }

    const warning = await this.containerBuildService.detectDependencyDrift(
      repo.path,
      worktree.path,
      worktree.container,
    )

    return this.inspectContainer(
      worktree.container.containerName,
      worktree.container.primaryHostPort,
      warning,
    )
  }

  async getStatuses(
    repo: Repo,
    worktrees: Worktree[],
  ): Promise<Map<string, ContainerRuntimeStatus>> {
    const entries = await Promise.all(
      worktrees.map(
        async (worktree) => [worktree.path, await this.getStatus(repo, worktree)] as const,
      ),
    )
    return new Map(entries)
  }

  async logs(worktree: Worktree, lines = 200): Promise<string> {
    if (!worktree.container) {
      throw new Error("No container metadata is stored for this worktree.")
    }

    const result = await this.runCommand("docker", [
      "logs",
      "--tail",
      String(lines),
      worktree.container.containerName,
    ])

    if (!result.success) {
      throw new Error(`Failed to fetch container logs: ${result.stderr || result.stdout}`)
    }

    return result.stdout || result.stderr
  }

  private async resolveMetadata(
    repo: Repo,
    worktree: Worktree,
    plan: ContainerBuildPlan,
  ): Promise<WorktreeContainerMetadata> {
    if (worktree.container) {
      return {
        ...worktree.container,
        baseImageTag: plan.baseImageTag,
        dependencyImageTag: plan.dependencyImageTag,
        dependencyFingerprint: plan.dependencyFingerprint,
      }
    }

    const primaryHostPort = await this.portAllocatorService.allocate(repo, worktree)
    const baseName = `swarm-${plan.repoIdentity.key}-${sanitizeSegment(worktree.slug)}`

    return {
      primaryHostPort,
      containerName: `${baseName}-container`,
      networkName: `${baseName}-network`,
      dataVolumeNames: DATA_VOLUME_SUFFIXES.map((suffix) => `${baseName}-${suffix}`),
      baseImageTag: plan.baseImageTag,
      dependencyImageTag: plan.dependencyImageTag,
      dependencyFingerprint: plan.dependencyFingerprint,
    }
  }

  private async ensureNetwork(networkName: string): Promise<void> {
    const inspectResult = await this.runCommand("docker", ["network", "inspect", networkName])
    if (inspectResult.success) return

    const createResult = await this.runCommand("docker", ["network", "create", networkName])
    if (!createResult.success) {
      throw new Error(
        `Failed to create Docker network: ${createResult.stderr || createResult.stdout}`,
      )
    }
  }

  private async ensureVolume(volumeName: string): Promise<void> {
    const inspectResult = await this.runCommand("docker", ["volume", "inspect", volumeName])
    if (inspectResult.success) return

    const createResult = await this.runCommand("docker", ["volume", "create", volumeName])
    if (!createResult.success) {
      throw new Error(
        `Failed to create Docker volume: ${createResult.stderr || createResult.stdout}`,
      )
    }
  }

  private async removeContainer(containerName: string): Promise<void> {
    const result = await this.runCommand("docker", ["rm", "-f", containerName])
    if (!result.success) {
      const message = result.stderr || result.stdout
      if (!message.includes("No such container")) {
        throw new Error(`Failed to remove container: ${message}`)
      }
    }
  }

  private async inspectContainer(
    containerName: string,
    primaryHostPort?: number,
    warning: string | null = null,
  ): Promise<ContainerRuntimeStatus> {
    const inspectResult = await this.runCommand("docker", [
      "inspect",
      "--format",
      "{{json .State}}",
      containerName,
    ])

    if (!inspectResult.success) {
      const message = inspectResult.stderr || inspectResult.stdout
      if (message.includes("No such object")) {
        return {
          state: "not-created",
          health: "none",
          primaryUrl: primaryHostPort ? `http://127.0.0.1:${primaryHostPort}` : null,
          message: "Container not created",
          warning,
        }
      }

      return {
        state: "unknown",
        health: "none",
        primaryUrl: primaryHostPort ? `http://127.0.0.1:${primaryHostPort}` : null,
        message: message || "Unable to inspect container",
        warning,
      }
    }

    const state = parseDockerState(inspectResult.stdout)
    return {
      state: state.running ? "running" : state.exitCode === 0 ? "stopped" : "failed",
      health: state.health,
      primaryUrl: primaryHostPort ? `http://127.0.0.1:${primaryHostPort}` : null,
      message: state.status,
      warning,
    }
  }
}

function parseDockerState(raw: string): {
  running: boolean
  exitCode: number
  status: string
  health: "healthy" | "unhealthy" | "starting" | "none"
} {
  const parsed = JSON.parse(raw) as {
    Running?: boolean
    ExitCode?: number
    Status?: string
    Health?: { Status?: string }
  }

  const healthStatus = parsed.Health?.Status
  const health =
    healthStatus === "healthy" || healthStatus === "unhealthy" || healthStatus === "starting"
      ? healthStatus
      : "none"

  return {
    running: parsed.Running === true,
    exitCode: typeof parsed.ExitCode === "number" ? parsed.ExitCode : 0,
    status: typeof parsed.Status === "string" ? parsed.Status : "unknown",
    health,
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-")
}
