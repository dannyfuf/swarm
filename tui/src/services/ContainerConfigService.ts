/**
 * Loads and validates repo-specific container config from Swarm-managed files.
 */

import { mkdir } from "node:fs/promises"
import { basename, isAbsolute, normalize } from "node:path"
import { parse as parseYaml } from "yaml"
import type {
  ContainerConfig,
  ContainerConfigScaffold,
  ContainerConfigSummary,
  ContainerPreset,
  ContainerProcessConfig,
  RepoIdentity,
} from "../types/container.js"
import type { RepoIdentityService } from "./RepoIdentityService.js"

const VALID_PRESETS: ReadonlyArray<ContainerPreset> = ["rails", "node-web", "python-web", "generic"]

const PRESET_DEFAULTS: Record<ContainerPreset, { baseImage: string; packages: string[] }> = {
  rails: { baseImage: "ruby:3.3-slim", packages: ["build-essential", "libpq-dev", "nodejs"] },
  "node-web": { baseImage: "node:22-bookworm-slim", packages: ["build-essential", "python3"] },
  "python-web": {
    baseImage: "python:3.12-slim",
    packages: ["build-essential", "python3-dev"],
  },
  generic: { baseImage: "debian:bookworm-slim", packages: ["build-essential", "curl", "git"] },
}

export interface ResolvedContainerConfig {
  path: string
  identity: RepoIdentity
  config: ContainerConfig
}

export class ContainerConfigService {
  constructor(
    private readonly repoIdentityService: RepoIdentityService,
    private readonly configHome: string = resolveConfigHome(),
  ) {}

  getConfigDirectory(): string {
    return `${this.configHome}/swarm/containers`
  }

  getExpectedConfigPath(repoPath: string): string {
    const identity = this.repoIdentityService.fromRepoPath(repoPath)
    return `${this.getConfigDirectory()}/${identity.key}.yml`
  }

  async getSummaryForRepo(repoPath: string): Promise<ContainerConfigSummary> {
    const expectedPath = this.getExpectedConfigPath(repoPath)
    const candidatePaths = [expectedPath, expectedPath.replace(/\.yml$/, ".yaml")]

    let content: string | null = null
    let resolvedPath: string | null = null

    for (const candidatePath of candidatePaths) {
      const file = Bun.file(candidatePath)
      if (await file.exists()) {
        content = await file.text()
        resolvedPath = candidatePath
        break
      }
    }

    if (content === null || resolvedPath === null) {
      return {
        state: "missing",
        path: expectedPath,
        resolvedPath: null,
        exists: false,
        isValid: false,
        preset: null,
        error: null,
      }
    }

    try {
      const raw = parseYaml(content) as unknown
      const config = validateContainerConfig(raw, repoPath)

      return {
        state: "present",
        path: expectedPath,
        resolvedPath,
        exists: true,
        isValid: true,
        preset: config.preset,
        error: null,
      }
    } catch (error) {
      return {
        state: "invalid",
        path: expectedPath,
        resolvedPath,
        exists: true,
        isValid: false,
        preset: null,
        error: toErrorMessage(error),
      }
    }
  }

  async ensureConfigScaffold(repoPath: string): Promise<ContainerConfigScaffold> {
    const targetPath = this.getExpectedConfigPath(repoPath)
    await mkdir(this.getConfigDirectory(), { recursive: true })

    const file = Bun.file(targetPath)
    if (await file.exists()) {
      return {
        path: targetPath,
        alreadyExisted: true,
        contents: await file.text(),
      }
    }

    const contents = buildConfigTemplate(repoPath)
    await Bun.write(targetPath, contents)

    return {
      path: targetPath,
      alreadyExisted: false,
      contents,
    }
  }

  async loadForRepo(repoPath: string): Promise<ResolvedContainerConfig> {
    const identity = this.repoIdentityService.fromRepoPath(repoPath)
    const summary = await this.getSummaryForRepo(repoPath)

    if (summary.state === "missing") {
      throw new Error(`Missing container config for repo. Expected file: ${summary.path}`)
    }

    if (summary.state === "invalid") {
      throw new Error(summary.error)
    }

    const content = await Bun.file(summary.resolvedPath).text()
    const raw = parseYaml(content) as unknown
    const config = validateContainerConfig(raw, repoPath)

    return {
      path: summary.resolvedPath,
      identity,
      config,
    }
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown container config error"
}

function validateContainerConfig(raw: unknown, repoPath: string): ContainerConfig {
  if (!isRecord(raw)) {
    throw new Error("Container config must be a YAML object.")
  }

  const schemaVersion = raw.schema_version
  if (schemaVersion !== 1) {
    throw new Error("Container config schema_version must be 1.")
  }

  if (typeof raw.repo_path !== "string") {
    throw new Error("Container config repo_path must be a string.")
  }

  const normalizedConfigRepoPath = normalize(raw.repo_path)
  const normalizedRepoPath = normalize(repoPath)
  if (normalizedConfigRepoPath !== normalizedRepoPath) {
    throw new Error(
      `Container config repo_path mismatch. Expected ${normalizedRepoPath}, got ${normalizedConfigRepoPath}.`,
    )
  }

  if (!VALID_PRESETS.includes(raw.preset as ContainerPreset)) {
    throw new Error(`Container config preset must be one of: ${VALID_PRESETS.join(", ")}.`)
  }
  const preset = raw.preset as ContainerPreset

  const runtime = isRecord(raw.runtime) ? raw.runtime : {}
  const env = isRecord(raw.env) ? raw.env : {}
  const build = isRecord(raw.build) ? raw.build : {}
  const setup = isRecord(raw.setup) ? raw.setup : {}
  const defaultRuntime = PRESET_DEFAULTS[preset]

  const envFile = parseEnvFile(env.file)
  const processes = parseProcesses(raw.processes)

  return {
    schemaVersion: 1,
    repoPath: normalizedRepoPath,
    preset,
    runtime: {
      baseImage:
        typeof runtime.base_image === "string" ? runtime.base_image : defaultRuntime.baseImage,
      packages: mergePackages(defaultRuntime.packages, runtime.packages),
    },
    env: {
      file: envFile,
      vars: parseStringRecord(env.vars, "env.vars"),
    },
    build: {
      install: parseOptionalCommand(build.install, "build.install"),
    },
    setup: {
      command: parseOptionalCommand(setup.command, "setup.command"),
    },
    processes,
  }
}

function parseEnvFile(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null
  if (typeof value !== "string") {
    throw new Error("Container config env.file must be a string when provided.")
  }
  if (isAbsolute(value)) {
    throw new Error("Container config env.file must be repo-relative, not absolute.")
  }

  const normalized = normalize(value)
  if (normalized.startsWith("..") || normalized.includes("../")) {
    throw new Error("Container config env.file must stay inside the repo.")
  }

  return normalized
}

function parseProcesses(value: unknown): ContainerProcessConfig[] {
  if (!isRecord(value)) {
    throw new Error("Container config processes must be an object keyed by process name.")
  }

  const processes: ContainerProcessConfig[] = []

  for (const [name, processValue] of Object.entries(value)) {
    if (!isRecord(processValue)) {
      throw new Error(`Process ${name} must be an object.`)
    }

    if (typeof processValue.command !== "string" || processValue.command.trim() === "") {
      throw new Error(`Process ${name} must define a non-empty command.`)
    }

    const expose = processValue.expose === true
    const internalPort =
      typeof processValue.internal_port === "number" ? processValue.internal_port : null

    if (expose && (internalPort === null || !Number.isInteger(internalPort) || internalPort <= 0)) {
      throw new Error(`Process ${name} must define a positive internal_port when expose is true.`)
    }

    processes.push({
      name,
      command: processValue.command,
      expose,
      internalPort,
    })
  }

  const exposedProcesses = processes.filter((process) => process.expose)
  if (exposedProcesses.length !== 1) {
    throw new Error("Container config must define exactly one exposed primary process.")
  }

  return processes
}

function parseStringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) {
    throw new Error(`Container config ${label} must be an object.`)
  }

  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(`Container config ${label}.${key} must be a string.`)
    }
    result[key] = entry
  }
  return result
}

function parseOptionalCommand(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null
  if (typeof value !== "string") {
    throw new Error(`Container config ${label} must be a string when provided.`)
  }
  return value
}

function mergePackages(defaultPackages: string[], value: unknown): string[] {
  if (value === undefined || value === null) return [...defaultPackages]
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("Container config runtime.packages must be an array of strings.")
  }
  return Array.from(new Set([...defaultPackages, ...value]))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function resolveConfigHome(): string {
  return process.env.XDG_CONFIG_HOME ?? `${process.env.HOME}/.config`
}

function buildConfigTemplate(repoPath: string): string {
  const repoName = basename(repoPath)

  return [
    "schema_version: 1",
    `repo_path: ${repoPath}`,
    "preset: generic",
    "",
    "runtime:",
    "  # Replace with a Debian-family base image that matches your project.",
    "  base_image: debian:bookworm-slim",
    "  packages:",
    "    - git",
    "",
    "env:",
    "  # Keep this repo-relative or set to null.",
    "  file: .env.development",
    "  vars:",
    "    APP_ENV: development",
    "",
    "build:",
    `  # Install dependencies for ${repoName}. Leave null if not needed.`,
    "  install: null",
    "",
    "setup:",
    "  # Optional setup command run before processes start.",
    "  command: null",
    "",
    "processes:",
    "  app:",
    "    # Replace with your main app command.",
    "    command: ./bin/start-dev",
    "    expose: true",
    "    internal_port: 3000",
    "  worker:",
    "    # Optional background process. Remove if unused.",
    "    command: ./bin/worker",
    "",
  ].join("\n")
}
