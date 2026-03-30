/**
 * Resolves repo dockerization directories and validates base compose files.
 */

import { mkdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { parse as parseYaml } from "yaml"
import type {
  ContainerConfigScaffold,
  ContainerConfigSummary,
  RepoDockerization,
  RepoIdentity,
} from "../types/container.js"
import type { RepoIdentityService } from "./RepoIdentityService.js"

const COMPOSE_FILE_CANDIDATES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
]

export interface ResolvedContainerConfig {
  path: string
  identity: RepoIdentity
  config: RepoDockerization
}

export class ContainerConfigService {
  constructor(
    private readonly repoIdentityService: RepoIdentityService,
    private readonly configHome: string = resolveConfigHome(),
  ) {}

  getConfigDirectory(): string {
    return `${this.configHome}/swarm/containers`
  }

  getDockerizationDir(repoPath: string): string {
    const identity = this.repoIdentityService.fromRepoPath(repoPath)
    return join(this.getConfigDirectory(), identity.name)
  }

  getExpectedConfigPath(repoPath: string): string {
    return this.getDockerizationDir(repoPath)
  }

  async getSummaryForRepo(repoPath: string): Promise<ContainerConfigSummary> {
    const dockerizationDir = this.getDockerizationDir(repoPath)

    if (!(await directoryExists(dockerizationDir))) {
      return {
        state: "missing",
        path: dockerizationDir,
        resolvedPath: null,
        exists: false,
        isValid: false,
        preset: null,
        dockerizationDir,
        composeFilePath: null,
        envFilePath: null,
        error: null,
      }
    }

    const composeFilePath = await this.resolveComposeFilePath(dockerizationDir)
    if (!composeFilePath) {
      return {
        state: "invalid",
        path: dockerizationDir,
        resolvedPath: null,
        exists: true,
        isValid: false,
        preset: null,
        dockerizationDir,
        composeFilePath: null,
        envFilePath: null,
        error: `Missing compose file. Expected one of: ${COMPOSE_FILE_CANDIDATES.join(", ")}.`,
      }
    }

    try {
      const dockerization = await this.validateDockerization(dockerizationDir, composeFilePath)

      return {
        state: "present",
        path: dockerizationDir,
        resolvedPath: composeFilePath,
        exists: true,
        isValid: true,
        preset: null,
        dockerizationDir,
        composeFilePath,
        envFilePath: dockerization.envFilePath,
        error: null,
      }
    } catch (error) {
      return {
        state: "invalid",
        path: dockerizationDir,
        resolvedPath: composeFilePath,
        exists: true,
        isValid: false,
        preset: null,
        dockerizationDir,
        composeFilePath,
        envFilePath: await this.resolveOptionalEnvFilePath(dockerizationDir),
        error: toErrorMessage(error),
      }
    }
  }

  async ensureConfigScaffold(repoPath: string): Promise<ContainerConfigScaffold> {
    const dockerizationDir = this.getDockerizationDir(repoPath)
    const composeFilePath = join(dockerizationDir, COMPOSE_FILE_CANDIDATES[0])

    await mkdir(dockerizationDir, { recursive: true })

    const composeFile = Bun.file(composeFilePath)
    if (await composeFile.exists()) {
      return {
        path: dockerizationDir,
        composeFilePath,
        alreadyExisted: true,
        contents: await composeFile.text(),
      }
    }

    const contents = buildComposeTemplate(repoPath)
    await Bun.write(composeFilePath, contents)

    return {
      path: dockerizationDir,
      composeFilePath,
      alreadyExisted: false,
      contents,
    }
  }

  async loadForRepo(repoPath: string): Promise<ResolvedContainerConfig> {
    const identity = this.repoIdentityService.fromRepoPath(repoPath)
    const summary = await this.getSummaryForRepo(repoPath)

    if (summary.state === "missing") {
      throw new Error(
        `Missing repo dockerization directory for ${identity.name}. Expected: ${summary.path}`,
      )
    }

    if (summary.state === "invalid") {
      throw new Error(summary.error)
    }

    if (!summary.composeFilePath || !summary.dockerizationDir) {
      throw new Error("Repo dockerization summary is missing compose details.")
    }

    return {
      path: summary.composeFilePath,
      identity,
      config: {
        dockerizationDir: summary.dockerizationDir,
        composeFilePath: summary.composeFilePath,
        envFilePath: summary.envFilePath ?? null,
        startupScriptPath: await this.resolveOptionalStartScriptPath(summary.dockerizationDir),
      },
    }
  }

  private async resolveComposeFilePath(dockerizationDir: string): Promise<string | null> {
    for (const candidate of COMPOSE_FILE_CANDIDATES) {
      const candidatePath = join(dockerizationDir, candidate)
      if (await Bun.file(candidatePath).exists()) {
        return candidatePath
      }
    }

    return null
  }

  private async resolveOptionalEnvFilePath(dockerizationDir: string): Promise<string | null> {
    const envFilePath = join(dockerizationDir, ".env")
    return (await Bun.file(envFilePath).exists()) ? envFilePath : null
  }

  private async resolveOptionalStartScriptPath(dockerizationDir: string): Promise<string | null> {
    const startScriptPath = join(dockerizationDir, "start.sh")
    return (await Bun.file(startScriptPath).exists()) ? startScriptPath : null
  }

  private async validateDockerization(
    dockerizationDir: string,
    composeFilePath: string,
  ): Promise<RepoDockerization> {
    const raw = parseYaml(await Bun.file(composeFilePath).text()) as unknown
    const composeConfig = parseComposeConfig(raw)

    if (Object.keys(composeConfig.services).length === 0) {
      throw new Error("Compose file must define at least one service.")
    }

    const envFilePath = await this.resolveOptionalEnvFilePath(dockerizationDir)
    const startupScriptPath = await this.resolveOptionalStartScriptPath(dockerizationDir)

    return {
      dockerizationDir,
      composeFilePath,
      envFilePath,
      startupScriptPath,
    }
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const entry = await stat(path)
    return entry.isDirectory()
  } catch {
    return false
  }
}

function parseComposeConfig(raw: unknown): { services: Record<string, unknown> } {
  if (!isRecord(raw)) {
    throw new Error("Compose file must parse to a YAML object.")
  }

  const services = raw.services
  if (!isRecord(services)) {
    throw new Error("Compose file must define a services map.")
  }

  return { services }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown repo dockerization error"
}

function resolveConfigHome(): string {
  return process.env.XDG_CONFIG_HOME ?? `${process.env.HOME}/.config`
}

function buildComposeTemplate(repoPath: string): string {
  return [
    "services:",
    "  app:",
    "    build:",
    "      context: .",
    "    working_dir: /workspace",
    "    command: bun run dev -- --host 0.0.0.0 --port " + "$" + "{APP_PORT}",
    "    ports:",
    '      - "' + "$" + "{APP_PORT:-3000}" + ':3000"',
    "    volumes:",
    `      - ${repoPath}:/workspace`,
    "",
  ].join("\n")
}
