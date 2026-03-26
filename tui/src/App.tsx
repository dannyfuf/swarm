/**
 * Root application component for the Swarm TUI.
 *
 * Composes all panels, dialogs, and overlays. Orchestrates data loading,
 * keyboard shortcut wiring, and command execution.
 */

import type { SelectOption } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { BuildContainerImageCommand } from "./commands/BuildContainerImageCommand.js"
import { CheckRemovalSafetyCommand } from "./commands/CheckRemovalSafetyCommand.js"
import { CloneRepoCommand } from "./commands/CloneRepoCommand.js"
import { ContainerStatusCommand } from "./commands/ContainerStatusCommand.js"
import { CopyToClipboardCommand } from "./commands/CopyToClipboardCommand.js"
import { CreateAndStartWorktreeCommand } from "./commands/CreateAndStartWorktreeCommand.js"
import { CreateWorktreeCommand } from "./commands/CreateWorktreeCommand.js"
import { DeleteWorktreeCommand } from "./commands/DeleteWorktreeCommand.js"
import { EnsureContainerConfigCommand } from "./commands/EnsureContainerConfigCommand.js"
import { OpenWorktreeCommand } from "./commands/OpenWorktreeCommand.js"
import { PruneOrphansCommand } from "./commands/PruneOrphansCommand.js"
import { RefreshCommand } from "./commands/RefreshCommand.js"
import { StartContainerCommand } from "./commands/StartContainerCommand.js"
import { StopContainerCommand } from "./commands/StopContainerCommand.js"
import { ActivityOverlay } from "./components/ActivityOverlay.js"
import { DetailView } from "./components/DetailView.js"
import { Dialog } from "./components/Dialog.js"
import { HelpDialog } from "./components/HelpDialog.js"
import { InputDialog } from "./components/InputDialog.js"
import { Panel } from "./components/Panel.js"
import { RepoBrowser } from "./components/RepoBrowser.js"
import { RepoList } from "./components/RepoList.js"
import { StatusBar } from "./components/StatusBar.js"
import { WorktreeList } from "./components/WorktreeList.js"
import { useAppState } from "./hooks/useAppState.js"
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts.js"
import { useServices } from "./hooks/useServices.js"
import type { ActiveOperation, ActivityDraft } from "./types/activity.js"
import type { ContainerConfigSummary, ContainerRuntimeStatus } from "./types/container.js"
import type { RemoteRepo } from "./types/github.js"
import type { CheckResult } from "./types/safety.js"
import type { Status } from "./types/status.js"
import type { Worktree } from "./types/worktree.js"
import { createActivityTracker } from "./utils/activity.js"

export function App() {
  const { state, dispatch } = useAppState()
  const services = useServices()
  const renderer = useRenderer()

  // Track selected indices for <select> components
  const [repoIndex, setRepoIndex] = useState(0)
  const [worktreeIndex, setWorktreeIndex] = useState(0)
  const [containerConfigSummaryRepoPath, setContainerConfigSummaryRepoPath] = useState<
    string | null
  >(null)
  const [selectedContainerConfigSummary, setSelectedContainerConfigSummary] =
    useState<ContainerConfigSummary | null>(null)
  const trackActivity = useMemo(() => createActivityTracker({ dispatch }), [dispatch])

  const selectedRepoPath = state.selectedRepo?.path ?? null

  // --- Data Loading ---

  /** Load the initial list of repos. */
  const loadRepos = useCallback(() => {
    try {
      const repos = services.repo.scanAll()
      dispatch({ type: "SET_REPOS", repos })
      if (repos.length > 0) {
        dispatch({ type: "SELECT_REPO", repo: repos[0] })
      }
    } catch (error) {
      dispatch({
        type: "SET_ERROR",
        message: error instanceof Error ? error.message : "Failed to load repos",
      })
    }
  }, [services.repo, dispatch])

  /** Load worktrees and statuses for the selected repo. */
  const loadWorktrees = useCallback(async () => {
    if (!state.selectedRepo) return
    try {
      const repo = state.selectedRepo
      const worktrees = await services.worktree.list(repo)
      dispatch({ type: "SET_WORKTREES", worktrees })

      // Compute statuses
      const items = worktrees.map((wt) => ({
        worktree: wt,
        options: {
          repoPath: repo.path,
          defaultBranch: repo.defaultBranch,
        },
      }))
      const statuses = await services.status.computeAll(items)
      dispatch({ type: "SET_STATUSES", statuses })
      const containerStatuses = await services.containerRuntime.getStatuses(repo, worktrees)
      dispatch({ type: "SET_CONTAINER_STATUSES", statuses: containerStatuses })
    } catch (error) {
      dispatch({
        type: "SET_ERROR",
        message: error instanceof Error ? error.message : "Failed to load worktrees",
      })
    }
  }, [
    state.selectedRepo,
    services.worktree,
    services.status,
    services.containerRuntime,
    services.containerRuntime.getStatuses,
    dispatch,
  ])

  const loadContainerConfigSummary = useCallback(
    async (repoPath: string) => {
      try {
        const summary = await services.containerConfig.getSummaryForRepo(repoPath)
        setContainerConfigSummaryRepoPath(repoPath)
        setSelectedContainerConfigSummary(summary)
      } catch (error) {
        setContainerConfigSummaryRepoPath(repoPath)
        setSelectedContainerConfigSummary(null)
        dispatch({
          type: "SET_ERROR",
          message:
            error instanceof Error ? error.message : "Failed to load container config summary",
        })
      }
    },
    [dispatch, services.containerConfig],
  )

  // Initial load
  useEffect(() => {
    loadRepos()
  }, [loadRepos])

  // Load worktrees when repo changes
  useEffect(() => {
    if (state.selectedRepo) {
      setWorktreeIndex(0)
      loadWorktrees()
    }
  }, [state.selectedRepo, loadWorktrees])

  useEffect(() => {
    if (!selectedRepoPath) {
      setContainerConfigSummaryRepoPath(null)
      setSelectedContainerConfigSummary(null)
      return
    }

    let cancelled = false
    setSelectedContainerConfigSummary(null)
    setContainerConfigSummaryRepoPath(selectedRepoPath)

    void services.containerConfig.getSummaryForRepo(selectedRepoPath).then(
      (summary) => {
        if (cancelled) return
        setContainerConfigSummaryRepoPath(selectedRepoPath)
        setSelectedContainerConfigSummary(summary)
      },
      (error: unknown) => {
        if (cancelled) return
        setContainerConfigSummaryRepoPath(selectedRepoPath)
        setSelectedContainerConfigSummary(null)
        dispatch({
          type: "SET_ERROR",
          message:
            error instanceof Error ? error.message : "Failed to load container config summary",
        })
      },
    )

    return () => {
      cancelled = true
    }
  }, [dispatch, selectedRepoPath, services.containerConfig])

  // --- Command Callbacks ---

  const handleRefresh = useCallback(
    async ({ quiet = false }: { quiet?: boolean } = {}) => {
      const selectedRepo = state.selectedRepo
      if (!selectedRepo) return

      const executeRefresh = async () => {
        const cmd = new RefreshCommand(services.worktree, services.status, selectedRepo)
        const result = await cmd.execute()
        if (result.success) {
          const data = result.data as { worktrees: Worktree[]; statuses: Map<string, Status> }
          const containerStatuses = await services.containerRuntime.getStatuses(
            selectedRepo,
            data.worktrees,
          )
          await loadContainerConfigSummary(selectedRepo.path)
          dispatch({ type: "SET_WORKTREES", worktrees: data.worktrees })
          dispatch({ type: "SET_STATUSES", statuses: data.statuses })
          dispatch({ type: "SET_CONTAINER_STATUSES", statuses: containerStatuses })
          if (!quiet) {
            dispatch({ type: "SET_STATUS", message: result.message })
          }
          return
        }

        if (quiet) {
          dispatch({ type: "APPEND_STATUS_DETAIL", message: `Warning: ${result.message}` })
          return
        }

        dispatch({ type: "SET_ERROR", message: result.message })
      }

      if (quiet) {
        await executeRefresh()
        return
      }

      await trackActivity(
        createRefreshActivity(selectedRepo.path, selectedRepo.name),
        executeRefresh,
      )
    },
    [
      state.selectedRepo,
      services.worktree,
      services.status,
      services.containerRuntime,
      dispatch,
      loadContainerConfigSummary,
      trackActivity,
    ],
  )

  const handleCreateWorktree = useCallback(
    async (branch: string, startContainer = false) => {
      const selectedRepo = state.selectedRepo
      if (!selectedRepo) return
      dispatch({ type: "SET_INPUT_MODE", mode: "none" })
      const activity = startContainer
        ? createCreateAndStartActivity(selectedRepo.path, branch)
        : createCreateWorktreeActivity(selectedRepo.path, branch)

      await trackActivity(activity, async () => {
        const cmd = startContainer
          ? new CreateAndStartWorktreeCommand(
              services.containerConfig,
              services.worktree,
              services.git,
              services.containerRuntime,
              selectedRepo,
              branch,
            )
          : new CreateWorktreeCommand(services.worktree, services.git, selectedRepo, branch)
        const result = await cmd.execute()
        if (result.success) {
          dispatch({ type: "SET_STATUS", message: result.message })
          await handleRefresh({ quiet: true })
        } else {
          dispatch({ type: "SET_ERROR", message: result.message })
        }
      })
    },
    [
      state.selectedRepo,
      services.worktree,
      services.git,
      services.containerConfig,
      services.containerRuntime,
      dispatch,
      handleRefresh,
      trackActivity,
    ],
  )

  const handleStartContainer = useCallback(async () => {
    const selectedRepo = state.selectedRepo
    const selectedWorktree = state.selectedWorktree
    if (!selectedRepo || !selectedWorktree) return

    await trackActivity(
      createStartContainerActivity(
        selectedRepo.path,
        selectedWorktree.path,
        selectedWorktree.branch,
      ),
      async () => {
        const cmd = new StartContainerCommand(
          services.containerConfig,
          services.containerRuntime,
          services.worktree,
          selectedRepo,
          selectedWorktree,
        )
        const result = await cmd.execute()
        if (result.success) {
          dispatch({ type: "SET_STATUS", message: result.message })
          const data = result.data as { warning?: string | null }
          if (data.warning) {
            dispatch({ type: "APPEND_STATUS_DETAIL", message: `Warning: ${data.warning}` })
          }
          await handleRefresh({ quiet: true })
        } else {
          const scaffold = result.data as { path?: string; alreadyExisted?: boolean } | undefined
          if (scaffold?.path) {
            dispatch({
              type: "SHOW_DIALOG",
              dialogType: "help",
              title: "Container Config Created",
              message: `${result.message}\n\nPath:\n${scaffold.path}\n\nUpdate the preset, commands, env file, and exposed port for this repo, then try again.`,
            })
          }
          dispatch({ type: "SET_ERROR", message: result.message })
        }
      },
    )
  }, [
    state.selectedRepo,
    state.selectedWorktree,
    services.containerConfig,
    services.containerRuntime,
    services.worktree,
    dispatch,
    handleRefresh,
    trackActivity,
  ])

  const handleStopContainer = useCallback(async () => {
    if (!state.selectedRepo || !state.selectedWorktree) return
    const cmd = new StopContainerCommand(
      services.containerRuntime,
      state.selectedRepo,
      state.selectedWorktree,
    )
    const result = await cmd.execute()
    if (result.success) {
      dispatch({ type: "SET_STATUS", message: result.message })
      const data = result.data as { warning?: string | null }
      if (data.warning) {
        dispatch({ type: "APPEND_STATUS_DETAIL", message: `Warning: ${data.warning}` })
      }
      await handleRefresh()
    } else {
      dispatch({ type: "SET_ERROR", message: result.message })
    }
  }, [
    state.selectedRepo,
    state.selectedWorktree,
    services.containerRuntime,
    dispatch,
    handleRefresh,
  ])

  const handleBuildContainerImage = useCallback(async () => {
    const selectedRepo = state.selectedRepo
    if (!selectedRepo) return

    await trackActivity(
      createBuildContainerImageActivity(
        selectedRepo.path,
        selectedRepo.name,
        state.selectedWorktree,
      ),
      async () => {
        const cmd = new BuildContainerImageCommand(
          services.containerConfig,
          services.containerBuild,
          selectedRepo,
          state.selectedWorktree ?? undefined,
        )
        const result = await cmd.execute()
        if (result.success) {
          dispatch({ type: "SET_STATUS", message: result.message })
          await handleRefresh({ quiet: true })
        } else {
          const scaffold = result.data as { path?: string; alreadyExisted?: boolean } | undefined
          if (scaffold?.path) {
            dispatch({
              type: "SHOW_DIALOG",
              dialogType: "help",
              title: "Container Config Created",
              message: `${result.message}\n\nPath:\n${scaffold.path}\n\nUpdate the preset and commands, then run the build again.`,
            })
          }
          dispatch({ type: "SET_ERROR", message: result.message })
        }
      },
    )
  }, [
    state.selectedRepo,
    state.selectedWorktree,
    services.containerConfig,
    services.containerBuild,
    dispatch,
    handleRefresh,
    trackActivity,
  ])

  const handleCreateContainerConfig = useCallback(async () => {
    if (!state.selectedRepo) return

    const cmd = new EnsureContainerConfigCommand(services.containerConfig, state.selectedRepo)
    const result = await cmd.execute()

    if (result.success) {
      const scaffold = result.data as { path: string }
      await loadContainerConfigSummary(state.selectedRepo.path)
      dispatch({ type: "SET_STATUS", message: result.message })
      dispatch({
        type: "SHOW_DIALOG",
        dialogType: "help",
        title: "Container Config",
        message: `${result.message}\n\nPath:\n${scaffold.path}\n\nSwarm created a starter file you can fill in now.`,
      })
    } else {
      dispatch({ type: "SET_ERROR", message: result.message })
    }
  }, [state.selectedRepo, services.containerConfig, dispatch, loadContainerConfigSummary])

  const handleInspectContainer = useCallback(async () => {
    if (!state.selectedRepo || !state.selectedWorktree) return

    const cmd = new ContainerStatusCommand(
      services.containerRuntime,
      state.selectedRepo,
      state.selectedWorktree,
    )
    const result = await cmd.execute()
    if (result.success) {
      const status = result.data as ContainerRuntimeStatus
      dispatch({
        type: "SET_CONTAINER_STATUSES",
        statuses: new Map(state.containerStatuses).set(state.selectedWorktree.path, status),
      })
      dispatch({ type: "SET_STATUS", message: result.message })
    } else {
      dispatch({ type: "SET_ERROR", message: result.message })
    }
  }, [
    state.selectedRepo,
    state.selectedWorktree,
    state.containerStatuses,
    services.containerRuntime,
    dispatch,
  ])

  const handleOpenWorktree = useCallback(async () => {
    if (!state.selectedRepo || !state.selectedWorktree) return
    const cmd = new OpenWorktreeCommand(
      services.tmux,
      services.worktree,
      state.selectedRepo,
      state.selectedWorktree,
    )
    const result = await cmd.execute()
    if (result.success) {
      // After opening in tmux the TUI exits (user is now in tmux session)
      renderer.destroy()
    } else {
      dispatch({ type: "SET_ERROR", message: result.message })
    }
  }, [
    state.selectedRepo,
    state.selectedWorktree,
    services.tmux,
    services.worktree,
    renderer,
    dispatch,
  ])

  const handleDeleteWorktree = useCallback(async () => {
    if (!state.selectedRepo || !state.selectedWorktree) return

    // First run safety check
    const safetyCmd = new CheckRemovalSafetyCommand(services.safety, state.selectedWorktree)
    const safetyResult = await safetyCmd.execute()
    const checkResult = safetyResult.data as CheckResult

    if (checkResult.blockers.length > 0) {
      const blockerMsg = checkResult.blockers.map((b) => b.message).join("\n")
      dispatch({ type: "SET_ERROR", message: `Cannot delete: ${blockerMsg}` })
      return
    }

    // Store safety result for the confirmation dialog
    dispatch({ type: "SET_SAFETY_RESULT", result: checkResult, worktree: state.selectedWorktree })

    const warningMsg =
      checkResult.warnings.length > 0 ? checkResult.warnings.map((w) => w.message).join("\n") : ""
    const containerWarning = state.selectedWorktree.container
      ? `${warningMsg ? "\n" : ""}Deleting this worktree will also remove its container, network, and data volumes.`
      : ""

    dispatch({
      type: "SHOW_DIALOG",
      dialogType: "delete",
      title: `Delete ${state.selectedWorktree.branch}?`,
      message:
        warningMsg || containerWarning
          ? `Warnings:\n${warningMsg}${containerWarning}\n\nAre you sure?`
          : `Delete worktree "${state.selectedWorktree.branch}"?`,
    })
  }, [state.selectedRepo, state.selectedWorktree, services.safety, dispatch])

  const handleConfirmDelete = useCallback(async () => {
    if (!state.selectedRepo || !state.safetyWorktree) return

    const worktreeToDelete = state.safetyWorktree
    const repoForDelete = state.selectedRepo
    const hasWarnings = state.safetyResult?.warnings && state.safetyResult.warnings.length > 0

    dispatch({ type: "CLOSE_DIALOG" })

    await trackActivity(
      createDeleteWorktreeActivity(repoForDelete.path, worktreeToDelete.branch),
      async () => {
        const cmd = new DeleteWorktreeCommand(
          services.worktree,
          services.containerRuntime,
          services.git,
          services.tmux,
          repoForDelete,
          worktreeToDelete,
          hasWarnings ?? false,
        )
        const result = await cmd.execute()
        if (result.success) {
          dispatch({ type: "SET_STATUS", message: result.message })
          setWorktreeIndex(0)
          await handleRefresh({ quiet: true })
          dispatch({ type: "SET_FOCUSED_PANEL", panel: "worktrees" })
        } else {
          dispatch({ type: "SET_ERROR", message: result.message })
        }
      },
    )
  }, [
    state.selectedRepo,
    state.safetyWorktree,
    state.safetyResult,
    services.worktree,
    services.containerRuntime,
    services.git,
    services.tmux,
    dispatch,
    handleRefresh,
    trackActivity,
  ])

  const handlePrune = useCallback(async () => {
    if (!state.selectedRepo) return

    dispatch({
      type: "SHOW_DIALOG",
      dialogType: "pruneOrphans",
      title: "Prune Orphans",
      message: "Remove all orphaned worktrees from state?",
    })
  }, [state.selectedRepo, dispatch])

  const handleConfirmPrune = useCallback(async () => {
    dispatch({ type: "CLOSE_DIALOG" })
    if (!state.selectedRepo) return

    const cmd = new PruneOrphansCommand(services.worktree, state.selectedRepo)
    const result = await cmd.execute()
    if (result.success) {
      dispatch({ type: "SET_STATUS", message: result.message })
      await handleRefresh()
    } else {
      dispatch({ type: "SET_ERROR", message: result.message })
    }
  }, [state.selectedRepo, services.worktree, dispatch, handleRefresh])

  const handleCopy = useCallback(async () => {
    const target = state.focusedPanel === "repos" ? state.selectedRepo : state.selectedWorktree
    if (!target) return
    const text = target.path
    const label = state.focusedPanel === "repos" ? "repo path" : "worktree path"
    const cmd = new CopyToClipboardCommand(services.clipboard, text, label)
    const result = await cmd.execute()
    if (result.success) {
      dispatch({ type: "SET_STATUS", message: result.message })
    } else {
      dispatch({ type: "SET_ERROR", message: result.message })
    }
  }, [state.focusedPanel, state.selectedRepo, state.selectedWorktree, services.clipboard, dispatch])

  const handleCopyBranch = useCallback(async () => {
    if (!state.selectedWorktree) return
    const cmd = new CopyToClipboardCommand(
      services.clipboard,
      state.selectedWorktree.branch,
      "branch name",
    )
    const result = await cmd.execute()
    if (result.success) {
      dispatch({ type: "SET_STATUS", message: result.message })
    } else {
      dispatch({ type: "SET_ERROR", message: result.message })
    }
  }, [state.selectedWorktree, services.clipboard, dispatch])

  const handleCopyContainerConfigPath = useCallback(async () => {
    if (!state.selectedRepo) return

    const configPath =
      selectedContainerConfigSummary?.path ??
      services.containerConfig.getExpectedConfigPath(state.selectedRepo.path)

    const cmd = new CopyToClipboardCommand(services.clipboard, configPath, "container config path")
    const result = await cmd.execute()

    if (result.success) {
      dispatch({ type: "SET_STATUS", message: result.message })
      if (selectedContainerConfigSummary?.state === "missing") {
        dispatch({ type: "APPEND_STATUS_DETAIL", message: "File not created yet." })
      }
    } else {
      dispatch({ type: "SET_ERROR", message: result.message })
    }
  }, [
    dispatch,
    selectedContainerConfigSummary,
    services.clipboard,
    services.containerConfig,
    state.selectedRepo,
  ])

  const handleHelp = useCallback(() => {
    dispatch({
      type: "SHOW_DIALOG",
      dialogType: "help",
      title: "Help",
      message: "",
    })
  }, [dispatch])

  const handleOpenRepoBrowser = useCallback(async () => {
    dispatch({ type: "SET_REMOTE_REPOS_LOADING" })
    dispatch({ type: "SHOW_REPO_BROWSER" })

    try {
      const remoteRepos = await services.github.listAccessibleRepos()
      const localRepoNames = new Set(state.repos.map((r) => r.name))

      const browsable = remoteRepos.map((remote) => ({
        remote,
        availability: localRepoNames.has(remote.name) ? "installed" : "available",
      })) as import("./types/github.js").BrowsableRepo[]

      dispatch({ type: "SET_REMOTE_REPOS", repos: browsable })
    } catch (error) {
      dispatch({
        type: "SET_ERROR",
        message: error instanceof Error ? error.message : "Failed to fetch remote repos",
      })
      dispatch({ type: "HIDE_REPO_BROWSER" })
    }
  }, [services.github, state.repos, dispatch])

  const handleCloneRepo = useCallback(
    async (remote: RemoteRepo) => {
      dispatch({
        type: "SET_REMOTE_REPO_STATUS",
        fullName: remote.fullName,
        availability: "cloning",
      })

      await trackActivity(createCloneRepoActivity(remote.fullName), async () => {
        const cmd = new CloneRepoCommand(
          services.github,
          services.config.get().aiWorkingDir,
          remote,
        )
        const result = await cmd.execute()
        if (result.success) {
          dispatch({
            type: "SET_REMOTE_REPO_STATUS",
            fullName: remote.fullName,
            availability: "installed",
          })
          dispatch({ type: "SET_STATUS", message: result.message })
          loadRepos()
        } else {
          dispatch({
            type: "SET_REMOTE_REPO_STATUS",
            fullName: remote.fullName,
            availability: "available",
          })
          dispatch({ type: "SET_ERROR", message: result.message })
        }
      })
    },
    [services.github, services.config, dispatch, trackActivity, loadRepos],
  )

  // --- Dialog Confirm Routing ---

  const handleDialogConfirm = useCallback(() => {
    switch (state.dialogType) {
      case "delete":
        handleConfirmDelete()
        break
      case "pruneOrphans":
        handleConfirmPrune()
        break
      case "help":
        dispatch({ type: "CLOSE_DIALOG" })
        break
      default:
        dispatch({ type: "CLOSE_DIALOG" })
    }
  }, [state.dialogType, handleConfirmDelete, handleConfirmPrune, dispatch])

  const handleDialogCancel = useCallback(() => {
    dispatch({ type: "CLOSE_DIALOG" })
  }, [dispatch])

  // --- Selection callbacks ---

  const handleRepoChange = useCallback((index: number, _option: SelectOption | null) => {
    setRepoIndex(index)
  }, [])

  const handleRepoSelect = useCallback(
    (_index: number, option: SelectOption | null) => {
      if (!option?.value) return
      dispatch({ type: "SELECT_REPO", repo: option.value })
      dispatch({ type: "SET_FOCUSED_PANEL", panel: "worktrees" })
    },
    [dispatch],
  )

  const handleWorktreeChange = useCallback(
    (index: number, option: SelectOption | null) => {
      setWorktreeIndex(index)
      if (option?.value) {
        dispatch({ type: "SELECT_WORKTREE", worktree: option.value })
      }
    },
    [dispatch],
  )

  const handleWorktreeSelect = useCallback(
    (_index: number, option: SelectOption | null) => {
      if (!option?.value) return
      dispatch({ type: "SELECT_WORKTREE", worktree: option.value })
      dispatch({ type: "SET_FOCUSED_PANEL", panel: "detail" })
    },
    [dispatch],
  )

  // --- Keyboard Shortcuts ---

  useKeyboardShortcuts({
    state,
    dispatch,
    onOpenWorktree: handleOpenWorktree,
    onDeleteWorktree: handleDeleteWorktree,
    onStartContainer: handleStartContainer,
    onStopContainer: handleStopContainer,
    onCreateAndStartWorktree: () => dispatch({ type: "SET_INPUT_MODE", mode: "createAndStart" }),
    onBuildContainerImage: handleBuildContainerImage,
    onEnsureContainerConfig: handleCreateContainerConfig,
    onRefresh: handleRefresh,
    onPrune: handlePrune,
    onCopy: handleCopy,
    onCopyBranch: handleCopyBranch,
    onCopyContainerConfigPath: handleCopyContainerConfigPath,
    onHelp: handleHelp,
    onInspectContainer: handleInspectContainer,
    onOpenRepoBrowser: handleOpenRepoBrowser,
  })

  // --- Status for detail view ---

  const selectedStatus = useMemo(
    () => (state.selectedWorktree ? state.statuses.get(state.selectedWorktree.path) : undefined),
    [state.selectedWorktree, state.statuses],
  )

  const selectedContainerStatus = useMemo(
    () =>
      state.selectedWorktree ? state.containerStatuses.get(state.selectedWorktree.path) : undefined,
    [state.selectedWorktree, state.containerStatuses],
  )

  const detailContainerConfigSummary = useMemo(() => {
    if (!selectedRepoPath || containerConfigSummaryRepoPath !== selectedRepoPath) {
      return null
    }

    return selectedContainerConfigSummary
  }, [containerConfigSummaryRepoPath, selectedContainerConfigSummary, selectedRepoPath])

  const selectedActivityLabel = useMemo(
    () => getSelectedActivityLabel(state.activeOperations, state.selectedWorktree),
    [state.activeOperations, state.selectedWorktree],
  )

  // --- Render ---

  if (state.loading) {
    return (
      <box width="100%" height="100%" justifyContent="center" alignItems="center">
        <text fg="#6366F1">Loading repositories...</text>
      </box>
    )
  }

  return (
    <box width="100%" height="100%" flexDirection="column">
      {/* Main content area: 3-panel layout */}
      <box flexGrow={1} flexDirection="row">
        {/* Left panel: Repos */}
        <box width="25%" flexDirection="column">
          <Panel title="Repositories" focused={state.focusedPanel === "repos"}>
            <RepoList
              repos={state.repos}
              selectedIndex={repoIndex}
              focused={
                state.focusedPanel === "repos" && state.inputMode === "none" && !state.showDialog
              }
              onSelect={handleRepoSelect}
              onChange={handleRepoChange}
            />
          </Panel>
        </box>

        {/* Center panel: Worktrees */}
        <box width="35%" flexDirection="column">
          <Panel title="Worktrees" focused={state.focusedPanel === "worktrees"}>
            <WorktreeList
              worktrees={state.worktrees}
              statuses={state.statuses}
              containerStatuses={state.containerStatuses}
              selectedIndex={worktreeIndex}
              focused={
                state.focusedPanel === "worktrees" &&
                state.inputMode === "none" &&
                !state.showDialog
              }
              onSelect={handleWorktreeSelect}
              onChange={handleWorktreeChange}
            />
          </Panel>
        </box>

        {/* Right panel: Detail */}
        <box width="40%" flexDirection="column">
          <Panel title="Detail" focused={state.focusedPanel === "detail"}>
            <DetailView
              worktree={state.selectedWorktree}
              status={selectedStatus}
              containerStatus={selectedContainerStatus}
              containerConfigSummary={detailContainerConfigSummary}
              activeOperationLabel={selectedActivityLabel}
            />
          </Panel>
        </box>
      </box>

      {/* Status bar */}
      <StatusBar
        focusedPanel={state.focusedPanel}
        errorMessage={state.errorMessage}
        statusMessage={state.statusMessage}
        inputMode={state.inputMode}
        showDialog={state.showDialog}
        activeOperationCount={state.activeOperations.length}
      />

      {/* Background activity overlay */}
      <ActivityOverlay activities={state.activeOperations} />

      {/* Input dialog overlay */}
      {(state.inputMode === "create" || state.inputMode === "createAndStart") && (
        <box position="absolute" top={0} left={0} width="100%" height="100%">
          <InputDialog
            title={state.inputMode === "createAndStart" ? "New Worktree + Start" : "New Worktree"}
            placeholder="feature/my-branch"
            onSubmit={(value) => handleCreateWorktree(value, state.inputMode === "createAndStart")}
            onCancel={() => dispatch({ type: "SET_INPUT_MODE", mode: "none" })}
          />
        </box>
      )}

      {/* Confirmation dialog overlay */}
      {state.showDialog && state.dialogType !== "help" && (
        <box position="absolute" top={0} left={0} width="100%" height="100%">
          <Dialog
            title={state.dialogTitle}
            message={state.dialogMessage}
            onConfirm={handleDialogConfirm}
            onCancel={handleDialogCancel}
            confirmLabel={state.dialogType === "delete" ? "Delete" : "Confirm"}
            cancelLabel="Cancel"
          />
        </box>
      )}

      {/* Help dialog overlay */}
      {state.showDialog && state.dialogType === "help" && (
        <box position="absolute" top={0} left={0} width="100%" height="100%">
          <HelpDialog
            onClose={handleDialogCancel}
            title={state.dialogTitle}
            message={state.dialogMessage}
          />
        </box>
      )}

      {/* Repo browser overlay */}
      {state.showRepoBrowser && (
        <box position="absolute" top={0} left={0} width="100%" height="100%">
          <RepoBrowser
            repos={state.remoteRepos}
            loading={state.remoteReposLoading}
            onClone={handleCloneRepo}
            onClose={() => dispatch({ type: "HIDE_REPO_BROWSER" })}
          />
        </box>
      )}
    </box>
  )
}

function createBuildContainerImageActivity(
  repoPath: string,
  repoName: string,
  worktree: Worktree | null,
): ActivityDraft {
  if (worktree) {
    return {
      kind: "build-container-image",
      label: `Building container image for ${worktree.branch}...`,
      priority: "foreground",
      scope: {
        repoPath,
        worktreePath: worktree.path,
      },
    }
  }

  return {
    kind: "build-container-image",
    label: `Building container image for ${repoName}...`,
    priority: "foreground",
    scope: { repoPath },
  }
}

function createCreateAndStartActivity(repoPath: string, branch: string): ActivityDraft {
  return {
    kind: "create-and-start-worktree",
    label: `Creating worktree and starting container for ${branch}...`,
    priority: "foreground",
    scope: {
      repoPath,
      branch,
    },
  }
}

function createCreateWorktreeActivity(repoPath: string, branch: string): ActivityDraft {
  return {
    kind: "create-worktree",
    label: `Creating worktree ${branch}...`,
    priority: "foreground",
    scope: {
      repoPath,
      branch,
    },
  }
}

function createDeleteWorktreeActivity(repoPath: string, branch: string): ActivityDraft {
  return {
    kind: "delete-worktree",
    label: `Deleting worktree ${branch}...`,
    priority: "foreground",
    scope: {
      repoPath,
      branch,
    },
  }
}

function createRefreshActivity(repoPath: string, repoName: string): ActivityDraft {
  return {
    kind: "refresh",
    label: `Refreshing ${repoName}...`,
    priority: "background",
    scope: { repoPath },
  }
}

function createStartContainerActivity(
  repoPath: string,
  worktreePath: string,
  branch: string,
): ActivityDraft {
  return {
    kind: "start-container",
    label: `Starting container for ${branch}...`,
    priority: "foreground",
    scope: {
      repoPath,
      worktreePath,
    },
  }
}

function createCloneRepoActivity(fullName: string): ActivityDraft {
  return {
    kind: "clone-repo",
    label: `Cloning ${fullName}...`,
    priority: "foreground",
    scope: {
      repoPath: fullName,
    },
  }
}

function getSelectedActivityLabel(
  activeOperations: ActiveOperation[],
  selectedWorktree: Worktree | null,
): string | null {
  if (!selectedWorktree) {
    return null
  }

  const selectedActivity = activeOperations.find(
    (activity) => activity.scope.worktreePath === selectedWorktree.path,
  )

  return selectedActivity?.label ?? null
}
