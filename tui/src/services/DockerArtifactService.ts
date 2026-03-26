/**
 * Generates inspectable Docker build artifacts under Swarm config storage.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type {
  ContainerArtifacts,
  ContainerConfig,
  ContainerProcessConfig,
  RepoIdentity,
} from "../types/container.js"

export class DockerArtifactService {
  constructor(private readonly configHome: string = resolveConfigHome()) {}

  getBuildRoot(): string {
    return `${this.configHome}/swarm/containers/.build`
  }

  async generateArtifacts(input: {
    sourcePath: string
    repoIdentity: RepoIdentity
    config: ContainerConfig
    baseImageTag: string
    dependencyFingerprint: string
    manifestPaths: string[]
  }): Promise<ContainerArtifacts> {
    const buildDir = join(this.getBuildRoot(), input.repoIdentity.key)
    const dependencyContextDir = join(buildDir, "variants", input.dependencyFingerprint)
    const baseDockerfilePath = join(buildDir, "Dockerfile.base")
    const dependencyDockerfilePath = join(dependencyContextDir, "Dockerfile")
    const entrypointPath = join(dependencyContextDir, "swarm-entrypoint.sh")
    const processDir = join(dependencyContextDir, "processes")
    const manifestDir = join(dependencyContextDir, ".manifests")
    const processScriptPaths: string[] = []

    await mkdir(processDir, { recursive: true })
    await mkdir(manifestDir, { recursive: true })

    for (const manifestPath of input.manifestPaths) {
      const sourcePath = join(input.sourcePath, manifestPath)
      const destinationPath = join(manifestDir, manifestPath)
      await mkdir(dirname(destinationPath), { recursive: true })
      const content = await readFile(sourcePath)
      await writeFile(destinationPath, content)
    }

    await writeFile(baseDockerfilePath, buildBaseDockerfile(input.config), "utf-8")

    for (const process of input.config.processes) {
      const processScriptPath = join(processDir, `${process.name}.sh`)
      processScriptPaths.push(processScriptPath)
      await writeFile(processScriptPath, buildProcessScript(process), "utf-8")
    }

    await writeFile(entrypointPath, buildEntrypointScript(input.config), "utf-8")
    await writeFile(
      dependencyDockerfilePath,
      buildDependencyDockerfile(input.baseImageTag, input.config),
      "utf-8",
    )

    return {
      buildDir,
      baseDockerfilePath,
      dependencyDockerfilePath,
      dependencyContextDir,
      entrypointPath,
      processScriptPaths,
    }
  }
}

function buildBaseDockerfile(config: ContainerConfig): string {
  const packages = Array.from(
    new Set(["bash", "ca-certificates", "curl", "git", ...config.runtime.packages]),
  )
  const packageInstall =
    packages.length > 0
      ? `RUN apt-get update && apt-get install -y ${packages.join(" ")} && rm -rf /var/lib/apt/lists/*`
      : ""

  return [
    `FROM ${config.runtime.baseImage}`,
    "ENV DEBIAN_FRONTEND=noninteractive",
    packageInstall,
    "WORKDIR /workspace",
    "RUN mkdir -p /workspace /var/lib/swarm/data /var/lib/swarm/cache",
    "",
  ]
    .filter(Boolean)
    .join("\n")
}

function buildDependencyDockerfile(baseImageTag: string, config: ContainerConfig): string {
  const installStep = config.build.install
    ? `RUN if [ -d /tmp/swarm-manifests ] && [ "$(find /tmp/swarm-manifests -mindepth 1 -maxdepth 1 | wc -l)" -gt 0 ]; then cp -R /tmp/swarm-manifests/. /workspace/; fi && bash -lc '${escapeForSingleQuotedShell(config.build.install)}'`
    : ""

  return [
    `FROM ${baseImageTag}`,
    "WORKDIR /workspace",
    "COPY .manifests/ /tmp/swarm-manifests/",
    "COPY processes/ /usr/local/bin/swarm-processes/",
    "COPY swarm-entrypoint.sh /usr/local/bin/swarm-entrypoint.sh",
    "RUN chmod +x /usr/local/bin/swarm-entrypoint.sh /usr/local/bin/swarm-processes/*.sh",
    installStep,
    'ENTRYPOINT ["/usr/local/bin/swarm-entrypoint.sh"]',
    "",
  ]
    .filter(Boolean)
    .join("\n")
}

function buildEntrypointScript(config: ContainerConfig): string {
  const processLaunches = config.processes
    .map((process) => `/usr/local/bin/swarm-processes/${process.name}.sh &`)
    .join("\n")

  const setupStep = config.setup.command
    ? `echo "[swarm] running setup"\nbash -lc '${escapeForSingleQuotedShell(config.setup.command)}'`
    : ""

  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "trap 'kill 0' TERM INT EXIT",
    "cd /workspace",
    setupStep,
    processLaunches,
    "wait -n",
    "exit $?",
    "",
  ]
    .filter(Boolean)
    .join("\n")
}

function buildProcessScript(process: ContainerProcessConfig): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `exec bash -lc '${escapeForSingleQuotedShell(process.command)}'`,
    "",
  ].join("\n")
}

function escapeForSingleQuotedShell(value: string): string {
  return value.replaceAll("'", "'\"'\"'")
}

function resolveConfigHome(): string {
  return process.env.XDG_CONFIG_HOME ?? `${process.env.HOME}/.config`
}
