/**
 * Builds repo base images and dependency-variant images for worktree containers.
 */

import type { ContainerBuildPlan, WorktreeContainerMetadata } from "../types/container.js"
import type { AsyncCommandRunner } from "../utils/shell.js"
import { exec } from "../utils/shell.js"
import type { ContainerConfigService } from "./ContainerConfigService.js"
import type { DependencyFingerprintService } from "./DependencyFingerprintService.js"
import type { DockerArtifactService } from "./DockerArtifactService.js"

export class ContainerBuildService {
  constructor(
    private readonly containerConfigService: ContainerConfigService,
    private readonly dependencyFingerprintService: DependencyFingerprintService,
    private readonly dockerArtifactService: DockerArtifactService,
    private readonly runCommand: AsyncCommandRunner = exec,
  ) {}

  async buildForRepo(
    repoPath: string,
    sourcePath: string,
    existingMetadata?: WorktreeContainerMetadata,
    force = false,
  ): Promise<ContainerBuildPlan> {
    const resolvedConfig = await this.containerConfigService.loadForRepo(repoPath)
    const dependency = await this.dependencyFingerprintService.compute(
      sourcePath,
      resolvedConfig.config.preset,
    )

    const baseImageTag = `swarm/${resolvedConfig.identity.name}:base-${resolvedConfig.identity.pathHash}`
    const currentDependencyImageTag = `swarm/${resolvedConfig.identity.name}:deps-${resolvedConfig.identity.pathHash}-${dependency.fingerprint}`

    const shouldWarnOnDrift =
      !force &&
      existingMetadata !== undefined &&
      existingMetadata.dependencyFingerprint !== dependency.fingerprint

    const dependencyFingerprint = shouldWarnOnDrift
      ? existingMetadata.dependencyFingerprint
      : dependency.fingerprint
    const dependencyImageTag = shouldWarnOnDrift
      ? existingMetadata.dependencyImageTag
      : currentDependencyImageTag

    const artifacts = await this.dockerArtifactService.generateArtifacts({
      sourcePath,
      repoIdentity: resolvedConfig.identity,
      config: resolvedConfig.config,
      baseImageTag,
      dependencyFingerprint: dependency.fingerprint,
      manifestPaths: dependency.manifestPaths,
    })

    const warning = shouldWarnOnDrift
      ? `Dependency manifests changed since the last built image for this worktree. Existing fingerprint: ${existingMetadata.dependencyFingerprint}, current fingerprint: ${dependency.fingerprint}.`
      : null

    await this.ensureDockerAvailable()
    await this.ensureImage(baseImageTag, artifacts.baseDockerfilePath, artifacts.buildDir, force)
    await this.ensureImage(
      dependencyImageTag,
      artifacts.dependencyDockerfilePath,
      artifacts.dependencyContextDir,
      force || !shouldWarnOnDrift,
    )

    return {
      repoIdentity: resolvedConfig.identity,
      config: resolvedConfig.config,
      dependencyFingerprint,
      baseImageTag,
      dependencyImageTag,
      artifacts,
      warning,
    }
  }

  async detectDependencyDrift(
    repoPath: string,
    sourcePath: string,
    metadata?: WorktreeContainerMetadata,
  ): Promise<string | null> {
    if (!metadata) {
      return null
    }

    const resolvedConfig = await this.containerConfigService.loadForRepo(repoPath)
    const dependency = await this.dependencyFingerprintService.compute(
      sourcePath,
      resolvedConfig.config.preset,
    )

    if (dependency.fingerprint === metadata.dependencyFingerprint) {
      return null
    }

    return `Dependency image is stale. Built fingerprint ${metadata.dependencyFingerprint}, current fingerprint ${dependency.fingerprint}. Run a rebuild with \`i\` or \`swarm container build\`.`
  }

  private async ensureDockerAvailable(): Promise<void> {
    const result = await this.runCommand("docker", ["info"])
    if (!result.success) {
      throw new Error(`Docker is unavailable: ${result.stderr || result.stdout}`)
    }
  }

  private async ensureImage(
    tag: string,
    dockerfilePath: string,
    contextDir: string,
    force: boolean,
  ): Promise<void> {
    if (!force) {
      const inspectResult = await this.runCommand("docker", ["image", "inspect", tag])
      if (inspectResult.success) {
        return
      }
    }

    const buildResult = await this.runCommand("docker", [
      "build",
      "-t",
      tag,
      "-f",
      dockerfilePath,
      contextDir,
    ])

    if (!buildResult.success) {
      throw new Error(`Docker build failed for ${tag}: ${buildResult.stderr || buildResult.stdout}`)
    }
  }
}
