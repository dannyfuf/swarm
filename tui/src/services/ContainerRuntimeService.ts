/**
 * Manages Docker Compose runtime lifecycle for worktree environments.
 */

import { rm } from "node:fs/promises"
import { dirname } from "node:path"
import type {
  ContainerBuildPlan,
  ContainerHealth,
  ContainerRuntimeState,
  ContainerRuntimeStatus,
  StartContainerResult,
  WorktreeContainerMetadata,
} from "../types/container.js"
import type { Repo } from "../types/repo.js"
import type { Worktree } from "../types/worktree.js"
import type { AsyncCommandRunner } from "../utils/shell.js"
import { exec } from "../utils/shell.js"
import { buildComposeArgs, type ContainerBuildService } from "./ContainerBuildService.js"

export class ContainerRuntimeService {
  private readonly runCommand: AsyncCommandRunner

  constructor(
    private readonly containerBuildService: ContainerBuildService,
    legacyOrRunCommand?: unknown,
    runCommand: AsyncCommandRunner = exec,
  ) {
    this.runCommand =
      typeof legacyOrRunCommand === "function"
        ? (legacyOrRunCommand as AsyncCommandRunner)
        : runCommand
  }

  async build(repo: Repo, worktree: Worktree): Promise<ContainerBuildPlan> {
    return this.containerBuildService.buildForWorktree(repo, worktree)
  }

  async start(repo: Repo, worktree: Worktree): Promise<StartContainerResult> {
    const plan = await this.containerBuildService.planForWorktree(repo, worktree)
    const upResult = plan.dockerization.startupScriptPath
      ? await this.runStartupScript(plan, repo, worktree)
      : await this.runCommand("docker", buildComposeArgs(plan, ["up", "-d"]))

    if (!upResult.success) {
      throw new Error(`Failed to start compose environment: ${upResult.stderr || upResult.stdout}`)
    }

    return {
      metadata: plan.metadata,
      status: await this.getStatusFromMetadata(plan.metadata),
      warning: plan.warning,
    }
  }

  async stop(worktree: Worktree): Promise<ContainerRuntimeStatus> {
    if (!worktree.container) {
      throw new Error("No compose metadata is stored for this worktree.")
    }

    const result = await this.runCommand(
      "docker",
      buildComposeCommandFromMetadata(worktree.container, ["down"]),
    )

    if (!result.success) {
      throw new Error(`Failed to stop compose environment: ${result.stderr || result.stdout}`)
    }

    return {
      state: "stopped",
      health: "none",
      primaryUrl: worktree.container.primaryUrl ?? null,
      message: "Compose environment stopped",
      warning: null,
      services: [],
    }
  }

  async removeEnvironment(worktree: Worktree): Promise<void> {
    if (!worktree.container) return

    const metadata = worktree.container

    const result = await this.runCommand("docker", buildComposeCommandFromMetadata(metadata, ["down", "-v", "--remove-orphans"]))

    if (!result.success) {
      const message = result.stderr || result.stdout
      if (message.includes("No such") || message.includes("not found")) {
        await removeBuildArtifacts(metadata)
        return
      }

      if (isMissingComposeArtifactError(message)) {
        await this.removeDanglingResources(metadata)
        await removeBuildArtifacts(metadata)
        return
      }

      throw new Error(`Failed to remove compose environment: ${message}`)
    }

    await removeBuildArtifacts(metadata)
  }

  async getStatus(repo: Repo, worktree: Worktree): Promise<ContainerRuntimeStatus> {
    if (!worktree.container) {
      return {
        state: "not-created",
        health: "none",
        primaryUrl: null,
        message: "No environment created",
        warning: null,
        services: [],
      }
    }

    const warning = await this.containerBuildService.detectDependencyDrift(repo, worktree)
    const status = await this.getStatusFromMetadata(worktree.container)

    return { ...status, warning }
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
      throw new Error("No compose metadata is stored for this worktree.")
    }

    const result = await this.runCommand(
      "docker",
      buildComposeCommandFromMetadata(worktree.container, ["logs", "--tail", String(lines)]),
    )

    if (!result.success) {
      throw new Error(`Failed to fetch compose logs: ${result.stderr || result.stdout}`)
    }

    return result.stdout || result.stderr
  }

  private async runStartupScript(
    plan: ContainerBuildPlan,
    repo: Repo,
    worktree: Worktree,
  ): Promise<Awaited<ReturnType<AsyncCommandRunner>>> {
    const startupScriptPath = plan.dockerization.startupScriptPath
    if (!startupScriptPath) {
      throw new Error("Startup script path is missing from the compose plan.")
    }

    const environment = buildStartupScriptEnvironment(plan, repo, worktree)

    return this.runCommand(
      "env",
      [
        ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
        "bash",
        startupScriptPath,
      ],
      plan.dockerization.dockerizationDir,
    )
  }

  private async getStatusFromMetadata(
    metadata: WorktreeContainerMetadata,
  ): Promise<ContainerRuntimeStatus> {
    const result = await this.runCommand(
      "docker",
      buildComposeCommandFromMetadata(metadata, ["ps", "--format", "json"]),
    )

    if (!result.success) {
      return {
        state: "unknown",
        health: "none",
        primaryUrl: metadata.primaryUrl ?? null,
        message: result.stderr || result.stdout || "Unable to inspect compose environment",
        warning: null,
        services: [],
      }
    }

    let services: Array<{
      name: string
      state: ContainerRuntimeState
      health: ContainerHealth
    }>

    try {
      services = parseComposePsOutput(result.stdout)
    } catch (error) {
      return {
        state: "unknown",
        health: "none",
        primaryUrl: metadata.primaryUrl ?? null,
        message: `Unable to parse compose status: ${toErrorMessage(error)}`,
        warning: null,
        services: [],
      }
    }

    if (services.length === 0) {
      return {
        state: "not-created",
        health: "none",
        primaryUrl: metadata.primaryUrl ?? null,
        message: "Compose environment not created",
        warning: null,
        services: [],
      }
    }

    const state = deriveOverallState(services.map((service) => service.state))
    const health = deriveOverallHealth(services.map((service) => service.health))

    return {
      state,
      health,
      primaryUrl: metadata.primaryUrl ?? null,
      message: `${services.length} compose service${services.length === 1 ? "" : "s"}`,
      warning: null,
      services,
    }
  }

  private async removeDanglingResources(metadata: WorktreeContainerMetadata): Promise<void> {
    await this.removeProjectDanglingResources(metadata.projectName)
    await this.removeNamedDanglingResources(metadata)
  }

  private async removeProjectDanglingResources(projectName?: string): Promise<void> {
    if (!projectName) return

    const resources = [
      {
        listArgs: ["ps", "-aq", "--filter", `label=com.docker.compose.project=${projectName}`],
        removePrefix: ["rm", "-f"],
      },
      {
        listArgs: ["network", "ls", "-q", "--filter", `label=com.docker.compose.project=${projectName}`],
        removePrefix: ["network", "rm"],
      },
      {
        listArgs: ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${projectName}`],
        removePrefix: ["volume", "rm"],
      },
    ]

    for (const resource of resources) {
      const listResult = await this.runCommand("docker", resource.listArgs)
      if (!listResult.success) continue

      const ids = parseDockerIdentifiers(listResult.stdout)
      if (ids.length === 0) continue

      const removeResult = await this.runCommand("docker", [...resource.removePrefix, ...ids])
      if (!removeResult.success && !isIgnorableRemovalError(removeResult.stderr || removeResult.stdout)) {
        throw new Error(removeResult.stderr || removeResult.stdout)
      }
    }
  }

  private async removeNamedDanglingResources(metadata: WorktreeContainerMetadata): Promise<void> {
    const cleanupTargets: string[][] = []

    if (metadata.containerName) {
      cleanupTargets.push(["rm", "-f", metadata.containerName])
    }

    if (metadata.networkName) {
      cleanupTargets.push(["network", "rm", metadata.networkName])
    }

    const dataVolumeNames = metadata.dataVolumeNames
    if (dataVolumeNames && dataVolumeNames.length > 0) {
      cleanupTargets.push(["volume", "rm", ...dataVolumeNames])
    }

    for (const args of cleanupTargets) {
      const result = await this.runCommand("docker", args)
      if (!result.success && !isIgnorableRemovalError(result.stderr || result.stdout)) {
        throw new Error(result.stderr || result.stdout)
      }
    }
  }
}

interface StartupScriptEnvironment {
  SWARM_CONTAINER_PROJECT_NAME: string
  SWARM_CONTAINER_WORKTREE_PATH: string
  SWARM_CONTAINER_REPO_PATH: string
  SWARM_CONTAINER_DOCKERIZATION_DIR: string
  SWARM_CONTAINER_COMPOSE_FILES: string
  SWARM_CONTAINER_ENV_FILE: string
  COMPOSE_PROJECT_NAME: string
  COMPOSE_FILE: string
  COMPOSE_PROFILES: string
  COMPOSE_ENV_FILES: string
}

function buildComposeCommandFromMetadata(
  metadata: WorktreeContainerMetadata,
  trailingArgs: string[],
): string[] {
  const composeArgs = ["compose"]

  for (const profile of metadata.activeProfiles ?? []) {
    composeArgs.push("--profile", profile)
  }

  for (const composeFile of metadata.composeFiles ?? []) {
    composeArgs.push("-f", composeFile)
  }

  composeArgs.push("--project-name", metadata.projectName ?? "swarm")
  composeArgs.push("--env-file", metadata.generatedEnvPath ?? "/dev/null")

  return [...composeArgs, ...trailingArgs]
}

function parseDockerIdentifiers(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function isMissingComposeArtifactError(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes("couldn't find env file") ||
    normalized.includes("no such file or directory") ||
    normalized.includes("failed to read")
  )
}

function isIgnorableRemovalError(message: string): boolean {
  const normalized = message.toLowerCase()
  return normalized.includes("no such") || normalized.includes("not found")
}

async function removeBuildArtifacts(metadata: WorktreeContainerMetadata): Promise<void> {
  const buildDir = resolveBuildDir(metadata)
  if (!buildDir) return

  await rm(buildDir, { recursive: true, force: true })
}

function resolveBuildDir(metadata: WorktreeContainerMetadata): string | null {
  if (metadata.generatedEnvPath) {
    return dirname(metadata.generatedEnvPath)
  }

  if (metadata.generatedOverridePath) {
    return dirname(metadata.generatedOverridePath)
  }

  return null
}

function parseComposePsOutput(output: string): Array<{
  name: string
  state: ContainerRuntimeState
  health: ContainerHealth
}> {
  const trimmed = output.trim()
  if (!trimmed) {
    return []
  }

  const items = parseComposePsItems(trimmed)

  return items.flatMap((item) => {
    if (!isRecord(item)) {
      return []
    }

    const rawState = typeof item.State === "string" ? item.State : "unknown"
    const rawHealth = typeof item.Health === "string" ? item.Health : "none"

    return [
      {
        name:
          typeof item.Service === "string"
            ? item.Service
            : typeof item.Name === "string"
              ? item.Name
              : "service",
        state: normalizeComposeState(rawState),
        health: normalizeHealth(rawHealth),
      },
    ]
  })
}

function parseComposePsItems(trimmed: string): unknown[] {
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return trimmed
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as unknown)
  }
}

function deriveOverallState(states: ContainerRuntimeState[]): ContainerRuntimeState {
  if (states.some((state) => state === "failed")) return "failed"
  if (states.some((state) => state === "running")) return "running"
  if (states.every((state) => state === "stopped")) return "stopped"
  if (states.every((state) => state === "not-created")) return "not-created"
  return "unknown"
}

function deriveOverallHealth(healths: ContainerHealth[]): ContainerHealth {
  if (healths.some((health) => health === "unhealthy")) return "unhealthy"
  if (healths.some((health) => health === "starting")) return "starting"
  if (healths.some((health) => health === "healthy")) return "healthy"
  return "none"
}

function normalizeComposeState(value: string): ContainerRuntimeState {
  switch (value) {
    case "running":
      return "running"
    case "exited":
    case "created":
      return "stopped"
    case "dead":
      return "failed"
    default:
      return "unknown"
  }
}

function normalizeHealth(value: string): ContainerHealth {
  switch (value) {
    case "healthy":
    case "unhealthy":
    case "starting":
      return value
    default:
      return "none"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error"
}

function buildStartupScriptEnvironment(
  plan: ContainerBuildPlan,
  repo: Repo,
  worktree: Worktree,
): StartupScriptEnvironment {
  const composeFiles = plan.metadata.composeFiles ?? []
  const composeProfiles = plan.metadata.activeProfiles ?? []
  const generatedEnvPath = plan.metadata.generatedEnvPath ?? ""

  return {
    SWARM_CONTAINER_PROJECT_NAME: plan.metadata.projectName ?? "swarm",
    SWARM_CONTAINER_WORKTREE_PATH: worktree.path,
    SWARM_CONTAINER_REPO_PATH: repo.path,
    SWARM_CONTAINER_DOCKERIZATION_DIR: plan.dockerization.dockerizationDir,
    SWARM_CONTAINER_COMPOSE_FILES: composeFiles.join(":"),
    SWARM_CONTAINER_ENV_FILE: generatedEnvPath,
    COMPOSE_PROJECT_NAME: plan.metadata.projectName ?? "swarm",
    COMPOSE_FILE: composeFiles.join(":"),
    COMPOSE_PROFILES: composeProfiles.join(","),
    COMPOSE_ENV_FILES: generatedEnvPath,
  }
}
