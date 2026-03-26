/**
 * Entry point for the Swarm TUI application.
 *
 * Initializes all services, creates the OpenTUI renderer,
 * and renders the React component tree.
 */

import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { App } from "./App.js"
import { runCli } from "./cli/ContainerCli.js"
import { ClipboardService } from "./services/ClipboardService.js"
import { ConfigService } from "./services/ConfigService.js"
import { ContainerBuildService } from "./services/ContainerBuildService.js"
import { ContainerConfigService } from "./services/ContainerConfigService.js"
import { ContainerRuntimeService } from "./services/ContainerRuntimeService.js"
import { DependencyFingerprintService } from "./services/DependencyFingerprintService.js"
import { DockerArtifactService } from "./services/DockerArtifactService.js"
import { GitHubService } from "./services/GitHubService.js"
import { GitService } from "./services/GitService.js"
import { PortAllocatorService } from "./services/PortAllocatorService.js"
import { RepoIdentityService } from "./services/RepoIdentityService.js"
import { RepoService } from "./services/RepoService.js"
import { SafetyService } from "./services/SafetyService.js"
import { StateService } from "./services/StateService.js"
import { StatusService } from "./services/StatusService.js"
import { TmuxService } from "./services/TmuxService.js"
import { WorktreeService } from "./services/WorktreeService.js"
import { AppProvider, type Services } from "./state/AppContext.js"

// Initialize services
const configService = new ConfigService()
const config = await configService.load()

const gitService = new GitService()
const tmuxService = new TmuxService()
const stateService = new StateService(config.aiWorkingDir)
const repoService = new RepoService(config, gitService)
const worktreeService = new WorktreeService(config, gitService, stateService)
const safetyService = new SafetyService(gitService)
const statusService = new StatusService(gitService, config.statusCacheTTL)
const clipboardService = new ClipboardService()
const repoIdentityService = new RepoIdentityService()
const containerConfigService = new ContainerConfigService(repoIdentityService)
const dependencyFingerprintService = new DependencyFingerprintService()
const dockerArtifactService = new DockerArtifactService()
const containerBuildService = new ContainerBuildService(
  containerConfigService,
  dependencyFingerprintService,
  dockerArtifactService,
)
const portAllocatorService = new PortAllocatorService(config, stateService)
const containerRuntimeService = new ContainerRuntimeService(
  containerBuildService,
  portAllocatorService,
)
const githubService = new GitHubService()

const services: Services = {
  config: configService,
  git: gitService,
  github: githubService,
  tmux: tmuxService,
  repo: repoService,
  worktree: worktreeService,
  safety: safetyService,
  status: statusService,
  state: stateService,
  clipboard: clipboardService,
  repoIdentity: repoIdentityService,
  containerConfig: containerConfigService,
  dependencyFingerprint: dependencyFingerprintService,
  dockerArtifacts: dockerArtifactService,
  containerBuild: containerBuildService,
  portAllocator: portAllocatorService,
  containerRuntime: containerRuntimeService,
}

const args = process.argv.slice(2)
if (args[0] === "container") {
  const exitCode = await runCli(args.slice(1), services)
  process.exitCode = exitCode
} else {
  // Create renderer
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
  })

  // Render app
  createRoot(renderer).render(
    <AppProvider services={services}>
      <App />
    </AppProvider>,
  )
}
