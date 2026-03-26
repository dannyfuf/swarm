/**
 * Container domain types for Swarm worktree environments.
 */

export type ContainerPreset = "rails" | "node-web" | "python-web" | "generic"

export interface RepoIdentity {
  name: string
  path: string
  pathHash: string
  key: string
}

export interface ContainerProcessConfig {
  name: string
  command: string
  expose: boolean
  internalPort: number | null
}

export interface ContainerConfig {
  schemaVersion: 1
  repoPath: string
  preset: ContainerPreset
  runtime: {
    baseImage: string
    packages: string[]
  }
  env: {
    file: string | null
    vars: Record<string, string>
  }
  build: {
    install: string | null
  }
  setup: {
    command: string | null
  }
  processes: ContainerProcessConfig[]
}

export interface ContainerConfigScaffold {
  path: string
  alreadyExisted: boolean
  contents: string
}

export type ContainerConfigSummary =
  | {
      state: "missing"
      path: string
      resolvedPath: null
      exists: false
      isValid: false
      preset: null
      error: null
    }
  | {
      state: "present"
      path: string
      resolvedPath: string
      exists: true
      isValid: true
      preset: ContainerPreset
      error: null
    }
  | {
      state: "invalid"
      path: string
      resolvedPath: string
      exists: true
      isValid: false
      preset: null
      error: string
    }

export interface WorktreeContainerMetadata {
  primaryHostPort: number
  containerName: string
  networkName: string
  dataVolumeNames: string[]
  baseImageTag: string
  dependencyImageTag: string
  dependencyFingerprint: string
}

export interface ContainerArtifacts {
  buildDir: string
  baseDockerfilePath: string
  dependencyDockerfilePath: string
  dependencyContextDir: string
  entrypointPath: string
  processScriptPaths: string[]
}

export interface ContainerBuildPlan {
  repoIdentity: RepoIdentity
  config: ContainerConfig
  dependencyFingerprint: string
  baseImageTag: string
  dependencyImageTag: string
  artifacts: ContainerArtifacts
  warning: string | null
}

export type ContainerHealth = "healthy" | "unhealthy" | "starting" | "none"

export type ContainerRuntimeState = "not-created" | "running" | "stopped" | "failed" | "unknown"

export interface ContainerRuntimeStatus {
  state: ContainerRuntimeState
  health: ContainerHealth
  primaryUrl: string | null
  message: string
  warning: string | null
}

export interface StartContainerResult {
  metadata: WorktreeContainerMetadata
  status: ContainerRuntimeStatus
  warning: string | null
}
