/**
 * Entry point for the Swarm TUI application.
 *
 * Initializes all services, creates the OpenTUI renderer,
 * and renders the React component tree.
 */

import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { App } from "./App.js"
import { ClipboardService } from "./services/ClipboardService.js"
import { ConfigService } from "./services/ConfigService.js"
import { GitService } from "./services/GitService.js"
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

const services: Services = {
  config: configService,
  git: gitService,
  tmux: tmuxService,
  repo: repoService,
  worktree: worktreeService,
  safety: safetyService,
  status: statusService,
  state: stateService,
  clipboard: clipboardService,
}

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
