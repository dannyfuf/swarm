/**
 * Prepares and builds worktree-scoped Docker Compose plans.
 */

import { basename } from "node:path"
import type { ContainerBuildPlan, WorktreeContainerMetadata } from "../types/container.js"
import type { Repo } from "../types/repo.js"
import type { Worktree } from "../types/worktree.js"
import type { AsyncCommandRunner } from "../utils/shell.js"
import { exec } from "../utils/shell.js"
import type { ContainerConfigService } from "./ContainerConfigService.js"
import type { DockerArtifactService } from "./DockerArtifactService.js"
import type { PortAllocatorService } from "./PortAllocatorService.js"

export class ContainerBuildService {
  constructor(
    private readonly containerConfigService: ContainerConfigService,
    private readonly dockerArtifactService: DockerArtifactService,
    private readonly portAllocatorService: PortAllocatorService,
    private readonly runCommand: AsyncCommandRunner = exec,
  ) {}

  async planForWorktree(repo: Repo, worktree: Worktree): Promise<ContainerBuildPlan> {
    const resolvedConfig = await this.containerConfigService.loadForRepo(repo.path)
    const generated = await this.dockerArtifactService.generateArtifacts({
      repoPath: repo.path,
      worktreePath: worktree.path,
      worktreeSlug: worktree.slug,
      repoIdentity: resolvedConfig.identity,
      dockerization: resolvedConfig.config,
      existingMetadata: worktree.container,
      allocatePublishedPorts: (portRequests) =>
        this.portAllocatorService.allocatePublishedPorts(repo, worktree, portRequests),
    })

    return {
      repoIdentity: resolvedConfig.identity,
      dockerization: resolvedConfig.config,
      metadata: generated.metadata,
      artifacts: generated.artifacts,
      warning: null,
    }
  }

  async buildForWorktree(repo: Repo, worktree: Worktree): Promise<ContainerBuildPlan> {
    const plan = await this.planForWorktree(repo, worktree)
    await this.ensureDockerComposeAvailable()

    const result = await this.runCommand("docker", buildComposeArgs(plan, ["build"]))
    if (!result.success) {
      throw new Error(`Docker compose build failed: ${result.stderr || result.stdout}`)
    }

    return plan
  }

  async buildForRepo(
    repoPath: string,
    sourcePath: string,
    existingMetadata?: WorktreeContainerMetadata,
  ): Promise<ContainerBuildPlan> {
    return this.buildForWorktree(
      toRepo(repoPath),
      toWorktree(repoPath, sourcePath, existingMetadata),
    )
  }

  async detectDependencyDrift(
    _repo: Repo | string,
    _worktree: Worktree | string,
    _metadata?: WorktreeContainerMetadata,
  ): Promise<string | null> {
    return null
  }

  private async ensureDockerComposeAvailable(): Promise<void> {
    const result = await this.runCommand("docker", ["compose", "version"])
    if (!result.success) {
      throw new Error(`Docker Compose is unavailable: ${result.stderr || result.stdout}`)
    }
  }
}

function toRepo(repoPath: string): Repo {
  return {
    name: basename(repoPath),
    path: repoPath,
    defaultBranch: "main",
    lastScanned: new Date(),
  }
}

function toWorktree(
  repoPath: string,
  sourcePath: string,
  existingMetadata?: WorktreeContainerMetadata,
): Worktree {
  const slug = basename(sourcePath)

  return {
    slug,
    branch: slug,
    path: sourcePath,
    repoName: basename(repoPath),
    createdAt: new Date(),
    lastOpenedAt: new Date(),
    tmuxSession: `${basename(repoPath)}--wt--${slug}`,
    container: existingMetadata,
    isOrphaned: false,
  }
}

export function buildComposeArgs(plan: ContainerBuildPlan, trailingArgs: string[]): string[] {
  const composeArgs = ["compose"]

  for (const profile of plan.metadata.activeProfiles ?? []) {
    composeArgs.push("--profile", profile)
  }

  for (const composeFile of plan.metadata.composeFiles ?? []) {
    composeArgs.push("-f", composeFile)
  }

  composeArgs.push("--project-name", plan.metadata.projectName ?? "swarm")
  composeArgs.push("--env-file", plan.metadata.generatedEnvPath ?? "/dev/null")

  return [...composeArgs, ...trailingArgs]
}
