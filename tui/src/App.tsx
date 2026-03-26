/**
 * Root application component for the Swarm TUI.
 *
 * Composes all panels, dialogs, and overlays. Orchestrates data loading,
 * keyboard shortcut wiring, and command execution.
 */

import type { SelectOption } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { CheckRemovalSafetyCommand } from "./commands/CheckRemovalSafetyCommand.js"
import { CopyToClipboardCommand } from "./commands/CopyToClipboardCommand.js"
import { CreateWorktreeCommand } from "./commands/CreateWorktreeCommand.js"
import { DeleteWorktreeCommand } from "./commands/DeleteWorktreeCommand.js"
import { OpenWorktreeCommand } from "./commands/OpenWorktreeCommand.js"
import { PruneOrphansCommand } from "./commands/PruneOrphansCommand.js"
import { RefreshCommand } from "./commands/RefreshCommand.js"
import { DetailView } from "./components/DetailView.js"
import { Dialog } from "./components/Dialog.js"
import { HelpDialog } from "./components/HelpDialog.js"
import { InputDialog } from "./components/InputDialog.js"
import { Panel } from "./components/Panel.js"
import { RepoList } from "./components/RepoList.js"
import { StatusBar } from "./components/StatusBar.js"
import { WorktreeList } from "./components/WorktreeList.js"
import { useAppState } from "./hooks/useAppState.js"
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts.js"
import { useServices } from "./hooks/useServices.js"
import type { CheckResult } from "./types/safety.js"
import type { Status } from "./types/status.js"
import type { Worktree } from "./types/worktree.js"

export function App() {
  const { state, dispatch } = useAppState()
  const services = useServices()
  const renderer = useRenderer()

  // Track selected indices for <select> components
  const [repoIndex, setRepoIndex] = useState(0)
  const [worktreeIndex, setWorktreeIndex] = useState(0)

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
    } catch (error) {
      dispatch({
        type: "SET_ERROR",
        message: error instanceof Error ? error.message : "Failed to load worktrees",
      })
    }
  }, [state.selectedRepo, services.worktree, services.status, dispatch])

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

  // --- Command Callbacks ---

  const handleRefresh = useCallback(async () => {
    if (!state.selectedRepo) return
    const cmd = new RefreshCommand(services.worktree, services.status, state.selectedRepo)
    const result = await cmd.execute()
    if (result.success) {
      const data = result.data as { worktrees: Worktree[]; statuses: Map<string, Status> }
      dispatch({ type: "SET_WORKTREES", worktrees: data.worktrees })
      dispatch({ type: "SET_STATUSES", statuses: data.statuses })
      dispatch({ type: "SET_STATUS", message: result.message })
    } else {
      dispatch({ type: "SET_ERROR", message: result.message })
    }
  }, [state.selectedRepo, services.worktree, services.status, dispatch])

  const handleCreateWorktree = useCallback(
    async (branch: string) => {
      if (!state.selectedRepo) return
      dispatch({ type: "SET_INPUT_MODE", mode: "none" })
      const cmd = new CreateWorktreeCommand(
        services.worktree,
        services.git,
        state.selectedRepo,
        branch,
      )
      const result = await cmd.execute()
      if (result.success) {
        dispatch({ type: "SET_STATUS", message: result.message })
        await handleRefresh()
      } else {
        dispatch({ type: "SET_ERROR", message: result.message })
      }
    },
    [state.selectedRepo, services.worktree, services.git, dispatch, handleRefresh],
  )

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

    dispatch({
      type: "SHOW_DIALOG",
      dialogType: "delete",
      title: `Delete ${state.selectedWorktree.branch}?`,
      message: warningMsg
        ? `Warnings:\n${warningMsg}\n\nAre you sure?`
        : `Delete worktree "${state.selectedWorktree.branch}"?`,
    })
  }, [state.selectedRepo, state.selectedWorktree, services.safety, dispatch])

  const handleConfirmDelete = useCallback(async () => {
    dispatch({ type: "CLOSE_DIALOG" })
    if (!state.selectedRepo || !state.safetyWorktree) return

    const hasWarnings = state.safetyResult?.warnings && state.safetyResult.warnings.length > 0
    const cmd = new DeleteWorktreeCommand(
      services.worktree,
      services.git,
      services.tmux,
      state.selectedRepo,
      state.safetyWorktree,
      hasWarnings ?? false,
    )
    const result = await cmd.execute()
    if (result.success) {
      dispatch({ type: "SET_STATUS", message: result.message })
      setWorktreeIndex(0)
      await handleRefresh()
    } else {
      dispatch({ type: "SET_ERROR", message: result.message })
    }
  }, [
    state.selectedRepo,
    state.safetyWorktree,
    state.safetyResult,
    services.worktree,
    services.git,
    services.tmux,
    dispatch,
    handleRefresh,
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

  const handleHelp = useCallback(() => {
    dispatch({
      type: "SHOW_DIALOG",
      dialogType: "help",
      title: "Help",
      message: "",
    })
  }, [dispatch])

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
    onRefresh: handleRefresh,
    onPrune: handlePrune,
    onCopy: handleCopy,
    onCopyBranch: handleCopyBranch,
    onHelp: handleHelp,
  })

  // --- Status for detail view ---

  const selectedStatus = useMemo(
    () => (state.selectedWorktree ? state.statuses.get(state.selectedWorktree.path) : undefined),
    [state.selectedWorktree, state.statuses],
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
            <DetailView worktree={state.selectedWorktree} status={selectedStatus} />
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
      />

      {/* Input dialog overlay */}
      {state.inputMode === "create" && (
        <box position="absolute" top={0} left={0} width="100%" height="100%">
          <InputDialog
            title="New Worktree"
            placeholder="feature/my-branch"
            onSubmit={handleCreateWorktree}
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
          />
        </box>
      )}

      {/* Help dialog overlay */}
      {state.showDialog && state.dialogType === "help" && (
        <box position="absolute" top={0} left={0} width="100%" height="100%">
          <HelpDialog onClose={handleDialogCancel} />
        </box>
      )}
    </box>
  )
}
