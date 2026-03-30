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

export interface RepoDockerization {
  dockerizationDir: string
  composeFilePath: string
  envFilePath: string | null
  startupScriptPath: string | null
}

export interface ContainerConfigScaffold {
  path: string
  composeFilePath: string
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
      dockerizationDir?: string
      composeFilePath?: null
      envFilePath?: null
      error: null
    }
  | {
      state: "present"
      path: string
      resolvedPath: string
      exists: true
      isValid: true
      preset: null
      dockerizationDir?: string
      composeFilePath?: string
      envFilePath?: string | null
      error: null
    }
  | {
      state: "invalid"
      path: string
      resolvedPath: string | null
      exists: boolean
      isValid: false
      preset: null
      dockerizationDir?: string
      composeFilePath?: string | null
      envFilePath?: string | null
      error: string
    }

export interface WorktreeContainerMetadata {
  projectName?: string
  dockerizationDir?: string
  composeFiles?: string[]
  activeProfiles?: string[]
  generatedOverridePath?: string
  generatedEnvPath?: string
  publishedPorts?: Record<string, number>
  primaryService?: string
  primaryUrl?: string | null
  primaryHostPort?: number
  containerName?: string
  networkName?: string
  dataVolumeNames?: string[]
  baseImageTag?: string
  dependencyImageTag?: string
  dependencyFingerprint?: string
}

export interface ContainerArtifacts {
  buildDir: string
  generatedOverridePath: string
  generatedEnvPath: string
  composePlanPath: string
}

export interface ContainerBuildPlan {
  repoIdentity: RepoIdentity
  dockerization: RepoDockerization
  metadata: WorktreeContainerMetadata
  artifacts: ContainerArtifacts
  warning: string | null
}

export type ContainerHealth = "healthy" | "unhealthy" | "starting" | "none"

export type ContainerRuntimeState = "not-created" | "running" | "stopped" | "failed" | "unknown"

export interface ContainerServiceStatus {
  name: string
  state: ContainerRuntimeState
  health: ContainerHealth
}

export interface ContainerRuntimeStatus {
  state: ContainerRuntimeState
  health: ContainerHealth
  primaryUrl: string | null
  message: string
  warning: string | null
  services?: ContainerServiceStatus[]
}

export interface StartContainerResult {
  metadata: WorktreeContainerMetadata
  status: ContainerRuntimeStatus
  warning: string | null
}
