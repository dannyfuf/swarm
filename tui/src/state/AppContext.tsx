/**
 * React context provider for the Swarm TUI application.
 *
 * Makes the application state, dispatch function, and service instances
 * available to all components via React context.
 */

import { createContext, type ReactNode, useMemo, useReducer } from "react"
import type { ClipboardService } from "../services/ClipboardService.js"
import type { ConfigService } from "../services/ConfigService.js"
import type { ContainerBuildService } from "../services/ContainerBuildService.js"
import type { ContainerConfigService } from "../services/ContainerConfigService.js"
import type { ContainerRuntimeService } from "../services/ContainerRuntimeService.js"
import type { DependencyFingerprintService } from "../services/DependencyFingerprintService.js"
import type { DockerArtifactService } from "../services/DockerArtifactService.js"
import type { GitHubService } from "../services/GitHubService.js"
import type { GitService } from "../services/GitService.js"
import type { PortAllocatorService } from "../services/PortAllocatorService.js"
import type { RepoIdentityService } from "../services/RepoIdentityService.js"
import type { RepoService } from "../services/RepoService.js"
import type { SafetyService } from "../services/SafetyService.js"
import type { StateService } from "../services/StateService.js"
import type { StatusService } from "../services/StatusService.js"
import type { TmuxService } from "../services/TmuxService.js"
import type { WorktreeService } from "../services/WorktreeService.js"
import type { AppAction } from "./actions.js"
import { type AppState, appReducer, initialState } from "./appReducer.js"

export interface Services {
  config: ConfigService
  git: GitService
  github: GitHubService
  tmux: TmuxService
  repo: RepoService
  worktree: WorktreeService
  safety: SafetyService
  status: StatusService
  state: StateService
  clipboard: ClipboardService
  repoIdentity: RepoIdentityService
  containerConfig: ContainerConfigService
  dependencyFingerprint: DependencyFingerprintService
  dockerArtifacts: DockerArtifactService
  containerBuild: ContainerBuildService
  portAllocator: PortAllocatorService
  containerRuntime: ContainerRuntimeService
}

interface AppContextValue {
  state: AppState
  dispatch: React.Dispatch<AppAction>
  services: Services
}

export const AppContext = createContext<AppContextValue | null>(null)

interface AppProviderProps {
  services: Services
  children: ReactNode
}

export function AppProvider({ services, children }: AppProviderProps) {
  const [state, dispatch] = useReducer(appReducer, initialState)

  const value = useMemo(() => ({ state, dispatch, services }), [state, services])

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
