/**
 * Generates worktree-specific Docker Compose artifacts under Swarm config storage.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import type {
  ContainerArtifacts,
  RepoDockerization,
  RepoIdentity,
  WorktreeContainerMetadata,
} from "../types/container.js"

type ComposePortRequest = {
  key: string
  serviceName: string
  targetPort: number
  envVarName: string | null
  requestedPublishedPort: number | null
}

type ComposeAnalysis = {
  primaryService: string
  portRequests: ComposePortRequest[]
  activeProfiles: string[]
  composeConfig: Record<string, unknown>
}

export class DockerArtifactService {
  constructor(private readonly configHome: string = resolveConfigHome()) {}

  getBuildRoot(): string {
    return `${this.configHome}/swarm/containers/.build`
  }

  async analyzeDockerization(dockerization: RepoDockerization): Promise<ComposeAnalysis> {
    const composeConfig = parseComposeRoot(await Bun.file(dockerization.composeFilePath).text())
    rejectExplicitResourceNames(composeConfig)

    const services = getServices(composeConfig)
    const serviceNames = Object.keys(services)
    if (serviceNames.length === 0) {
      throw new Error("Compose file must define at least one service.")
    }

    const portRequests = serviceNames.flatMap((serviceName) =>
      collectServicePortRequests(serviceName, services[serviceName]),
    )
    const activeProfiles = collectActiveProfiles(services)
    const primaryService = portRequests[0]?.serviceName ?? serviceNames[0]

    return {
      primaryService,
      portRequests,
      activeProfiles,
      composeConfig,
    }
  }

  async generateArtifacts(input: {
    repoPath: string
    worktreePath: string
    worktreeSlug: string
    repoIdentity: RepoIdentity
    dockerization: RepoDockerization
    existingMetadata?: WorktreeContainerMetadata
    allocatePublishedPorts: (
      portRequests: ComposePortRequest[],
    ) => Promise<Record<string, number>>
  }): Promise<{ artifacts: ContainerArtifacts; metadata: WorktreeContainerMetadata }> {
    const analysis = await this.analyzeDockerization(input.dockerization)
    const publishedPorts = await input.allocatePublishedPorts(analysis.portRequests)
    const projectName = `swarm-${input.repoIdentity.name}-${sanitizeSegment(input.worktreeSlug)}`

    const buildDir = join(
      this.getBuildRoot(),
      input.repoIdentity.name,
      sanitizeSegment(input.worktreeSlug),
    )
    const generatedOverridePath = join(buildDir, "docker-compose.override.yml")
    const generatedEnvPath = join(buildDir, ".env.worktree")
    const composePlanPath = join(buildDir, "compose-plan.json")

    await mkdir(buildDir, { recursive: true })

    const overrideConfig = buildOverrideCompose({
      composeConfig: analysis.composeConfig,
      repoPath: input.repoPath,
      worktreePath: input.worktreePath,
      generatedEnvPath,
      portRequests: analysis.portRequests,
      publishedPorts,
    })

    const envFileContents = await buildGeneratedEnvFile(
      input.dockerization.envFilePath,
      analysis.portRequests,
      publishedPorts,
    )

    await writeFile(generatedOverridePath, stringifyOverrideCompose(overrideConfig), "utf-8")
    await writeFile(generatedEnvPath, envFileContents, "utf-8")

    const primaryPort = publishedPorts[analysis.portRequests[0]?.key ?? ""]
    const metadata: WorktreeContainerMetadata = {
      projectName,
      dockerizationDir: input.dockerization.dockerizationDir,
      composeFiles: [input.dockerization.composeFilePath, generatedOverridePath],
      activeProfiles: analysis.activeProfiles,
      generatedOverridePath,
      generatedEnvPath,
      publishedPorts,
      primaryService: input.existingMetadata?.primaryService ?? analysis.primaryService,
      primaryUrl: typeof primaryPort === "number" ? `http://127.0.0.1:${primaryPort}` : null,
    }

    await writeFile(
      composePlanPath,
      JSON.stringify(
        {
          projectName,
          repoPath: input.repoPath,
          worktreePath: input.worktreePath,
          dockerization: input.dockerization,
          publishedPorts,
          primaryService: metadata.primaryService,
        },
        null,
        2,
      ),
      "utf-8",
    )

    return {
      artifacts: {
        buildDir,
        generatedOverridePath,
        generatedEnvPath,
        composePlanPath,
      },
      metadata,
    }
  }
}

function parseComposeRoot(content: string): Record<string, unknown> {
  const raw = parseYaml(content) as unknown
  if (!isRecord(raw)) {
    throw new Error("Compose file must parse to a YAML object.")
  }
  return raw
}

function rejectExplicitResourceNames(composeConfig: Record<string, unknown>): void {
  const volumes = composeConfig.volumes
  if (isRecord(volumes)) {
    for (const [name, value] of Object.entries(volumes)) {
      if (isRecord(value) && typeof value.name === "string") {
        throw new Error(
          `Compose volume ${name} uses an explicit name override, which Swarm cannot isolate safely.`,
        )
      }
    }
  }

  const networks = composeConfig.networks
  if (isRecord(networks)) {
    for (const [name, value] of Object.entries(networks)) {
      if (isRecord(value) && typeof value.name === "string") {
        throw new Error(
          `Compose network ${name} uses an explicit name override, which Swarm cannot isolate safely.`,
        )
      }
    }
  }
}

function getServices(composeConfig: Record<string, unknown>): Record<string, unknown> {
  const services = composeConfig.services
  if (!isRecord(services)) {
    throw new Error("Compose file must define a services map.")
  }
  return services
}

function collectActiveProfiles(services: Record<string, unknown>): string[] {
  const profiles = new Set<string>()

  for (const serviceValue of Object.values(services)) {
    if (!isRecord(serviceValue) || !Array.isArray(serviceValue.profiles)) {
      continue
    }

    for (const profile of serviceValue.profiles) {
      if (typeof profile === "string" && profile.length > 0) {
        profiles.add(profile)
      }
    }
  }

  return [...profiles].sort()
}

function collectServicePortRequests(
  serviceName: string,
  serviceValue: unknown,
): ComposePortRequest[] {
  if (!isRecord(serviceValue)) {
    throw new Error(`Compose service ${serviceName} must be an object.`)
  }

  const ports = serviceValue.ports
  if (!Array.isArray(ports)) {
    return []
  }

  return ports.flatMap((entry, index) => {
    const parsed = parsePortBinding(serviceName, entry, index)
    return parsed ? [parsed] : []
  })
}

function parsePortBinding(
  serviceName: string,
  entry: unknown,
  index: number,
): ComposePortRequest | null {
  if (typeof entry === "string") {
    const parsedBinding = parseStringPortBinding(entry)
    if (!parsedBinding) {
      throw new Error(`Compose service ${serviceName} port entry #${index + 1} is not supported.`)
    }

    const targetSegment = parsedBinding.target
    if (!targetSegment) return null

    const targetPort = parsePortNumber(targetSegment)
    if (targetPort === null) return null

    return {
      key: parsedBinding.envVarName ?? `${serviceName}:${targetPort}`,
      serviceName,
      targetPort,
      envVarName: parsedBinding.envVarName,
      requestedPublishedPort: parsedBinding.requestedPublishedPort,
    }
  }

  if (isRecord(entry) && typeof entry.target === "number") {
    const envVarName = parseEnvReference(entry.published)
    return {
      key: envVarName ?? `${serviceName}:${entry.target}`,
      serviceName,
      targetPort: entry.target,
      envVarName,
      requestedPublishedPort: typeof entry.published === "number" ? entry.published : null,
    }
  }

  throw new Error(`Compose service ${serviceName} port entry #${index + 1} is not supported.`)
}

function parsePortNumber(value: string): number | null {
  const numericPort = Number.parseInt(value.split("/")[0] ?? "", 10)
  return Number.isInteger(numericPort) && numericPort > 0 ? numericPort : null
}

function parseStringPortBinding(
  value: string,
): { target: string; envVarName: string | null; requestedPublishedPort: number | null } | null {
  const trimmed = value.trim()

  const envMatch = trimmed.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-?[^}]*)?\}:(\d+(?:\/\w+)?)$/)
  if (envMatch) {
    return {
      envVarName: envMatch[1],
      target: envMatch[2],
      requestedPublishedPort: null,
    }
  }

  const fixedPortMatch = trimmed.match(/^(?:[^:]+:)?(\d+):(\d+(?:\/\w+)?)$/)
  if (fixedPortMatch) {
    return {
      envVarName: null,
      requestedPublishedPort: Number.parseInt(fixedPortMatch[1], 10),
      target: fixedPortMatch[2],
    }
  }

  const simpleMatch = trimmed.match(/^(?:(?:[^:]+):)?(\d+(?:\/\w+)?)$/)
  if (simpleMatch) {
    return {
      envVarName: null,
      target: simpleMatch[1],
      requestedPublishedPort: null,
    }
  }

  return null
}

function parseEnvReference(value: unknown): string | null {
  if (typeof value !== "string") {
    return null
  }

  const match = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-?[^}]*)?\}$/)
  return match?.[1] ?? null
}

function buildOverrideCompose(input: {
  composeConfig: Record<string, unknown>
  repoPath: string
  worktreePath: string
  generatedEnvPath: string
  portRequests: ComposePortRequest[]
  publishedPorts: Record<string, number>
}): Record<string, unknown> {
  const services = getServices(input.composeConfig)
  const overrideServices: Record<string, unknown> = {}

  for (const [serviceName, serviceValue] of Object.entries(services)) {
    if (!isRecord(serviceValue)) {
      throw new Error(`Compose service ${serviceName} must be an object.`)
    }

    const overrideService: Record<string, unknown> = {}
    const build = rewriteBuildDefinition(serviceValue.build, input.repoPath, input.worktreePath)
    if (build !== undefined) {
      overrideService.build = build
    }

    const volumes = rewriteVolumes(serviceValue.volumes, input.repoPath, input.worktreePath)
    if (volumes !== undefined) {
      overrideService.volumes = volumes
    }

    if (serviceValue.env_file !== undefined) {
      overrideService.env_file = [input.generatedEnvPath]
    }

    const servicePortRequests = input.portRequests.filter(
      (request) => request.serviceName === serviceName,
    )
    if (servicePortRequests.length > 0) {
      overrideService.ports = servicePortRequests.map((request) => ({
        target: request.targetPort,
        published: input.publishedPorts[request.key],
        protocol: "tcp",
      }))
    }

    if (Object.keys(overrideService).length > 0) {
      overrideServices[serviceName] = overrideService
    }
  }

  return {
    services: overrideServices,
  }
}

function stringifyOverrideCompose(overrideConfig: Record<string, unknown>): string {
  const services = getServices(overrideConfig)
  const lines = ["services:"]

  for (const [serviceName, serviceValue] of Object.entries(services)) {
    if (!isRecord(serviceValue)) {
      throw new Error(`Compose override service ${serviceName} must be an object.`)
    }

    lines.push(`  ${serviceName}:`)

    for (const [key, value] of Object.entries(serviceValue)) {
      if ((key === "ports" || key === "env_file") && Array.isArray(value)) {
        lines.push(`    ${key}: !override`)
        lines.push(indentYaml(stringifyYaml(value), 6))
        continue
      }

      lines.push(indentYaml(stringifyYaml({ [key]: value }).trimEnd(), 4))
    }
  }

  return `${lines.join("\n")}\n`
}

function indentYaml(value: string, spaces: number): string {
  const indent = " ".repeat(spaces)
  return value
    .trimEnd()
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n")
}

function rewriteBuildDefinition(
  buildValue: unknown,
  repoPath: string,
  worktreePath: string,
): unknown {
  if (typeof buildValue === "string") {
    return remapRepoPath(buildValue, repoPath, worktreePath)
  }

  if (!isRecord(buildValue)) {
    return undefined
  }

  const nextBuild: Record<string, unknown> = { ...buildValue }
  if (typeof buildValue.context === "string") {
    nextBuild.context = remapRepoPath(buildValue.context, repoPath, worktreePath)
  }
  if (typeof buildValue.dockerfile === "string") {
    nextBuild.dockerfile = remapRepoPath(buildValue.dockerfile, repoPath, worktreePath)
  }
  return nextBuild
}

function rewriteVolumes(volumesValue: unknown, repoPath: string, worktreePath: string): unknown {
  if (!Array.isArray(volumesValue)) {
    return undefined
  }

  return volumesValue.map((entry) => {
    if (typeof entry === "string") {
      const match = entry.match(/^([^:]+):(.*)$/)
      if (!match) {
        return entry
      }

      const [, source, remainder] = match
      return `${remapRepoPath(source, repoPath, worktreePath)}:${remainder}`
    }

    if (!isRecord(entry)) {
      return entry
    }

    if (entry.type === "bind" && typeof entry.source === "string") {
      return {
        ...entry,
        source: remapRepoPath(entry.source, repoPath, worktreePath),
      }
    }

    return entry
  })
}

function remapRepoPath(candidatePath: string, repoPath: string, worktreePath: string): string {
  if (!isAbsolute(candidatePath)) {
    return candidatePath
  }

  const relativeSuffix = relative(repoPath, candidatePath)
  if (relativeSuffix.startsWith("..") || relativeSuffix === "") {
    return candidatePath === repoPath ? worktreePath : candidatePath
  }

  return join(worktreePath, relativeSuffix)
}

async function buildGeneratedEnvFile(
  baseEnvFilePath: string | null,
  portRequests: ComposePortRequest[],
  publishedPorts: Record<string, number>,
): Promise<string> {
  const envEntries = new Map<string, string>()

  if (baseEnvFilePath) {
    for (const line of (await readFile(baseEnvFilePath, "utf-8")).split("\n")) {
      const parsed = parseEnvAssignment(line)
      if (parsed) {
        envEntries.set(parsed.key, parsed.value)
      }
    }
  }

  for (const request of portRequests) {
    if (request.envVarName) {
      envEntries.set(request.envVarName, String(publishedPorts[request.key]))
    }
  }

  const webpackPort = envEntries.get("WEBPACK_PORT")
  if (webpackPort) {
    envEntries.set("WEBPACKER_PUBLIC", `localhost:${webpackPort}`)
    envEntries.set("DOCKER_ASSET_HOST", `http://localhost:${webpackPort}`)
  }

  return `${Array.from(envEntries.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`
}

function parseEnvAssignment(line: string): { key: string; value: string } | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith("#")) {
    return null
  }

  const separatorIndex = trimmed.indexOf("=")
  if (separatorIndex <= 0) {
    return null
  }

  return {
    key: trimmed.slice(0, separatorIndex),
    value: trimmed.slice(separatorIndex + 1),
  }
}

function sanitizeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function resolveConfigHome(): string {
  return process.env.XDG_CONFIG_HOME ?? `${process.env.HOME}/.config`
}
