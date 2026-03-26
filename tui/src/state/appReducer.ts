/**
 * Application state reducer for the Swarm TUI.
 *
 * Pure function that handles all state transitions based on dispatched actions.
 * The state shape mirrors the Go `internal/tui/model.go` Model struct.
 */

import type { ActiveOperation } from "../types/activity.js"
import type { ContainerRuntimeStatus } from "../types/container.js"
import type { BrowsableRepo } from "../types/github.js"
import type { Repo } from "../types/repo.js"
import type { CheckResult } from "../types/safety.js"
import type { Status } from "../types/status.js"
import type { Worktree } from "../types/worktree.js"
import type { AppAction, DialogType, InputMode, Panel } from "./actions.js"

export interface AppState {
  repos: Repo[]
  worktrees: Worktree[]
  statuses: Map<string, Status>
  containerStatuses: Map<string, ContainerRuntimeStatus>
  selectedRepo: Repo | null
  selectedWorktree: Worktree | null
  focusedPanel: Panel
  inputMode: InputMode
  dialogType: DialogType
  dialogTitle: string
  dialogMessage: string
  showDialog: boolean
  errorMessage: string
  statusMessage: string
  safetyResult: CheckResult | null
  safetyWorktree: Worktree | null
  loading: boolean
  activeOperations: ActiveOperation[]
  showRepoBrowser: boolean
  remoteRepos: BrowsableRepo[]
  remoteReposLoading: boolean
}

export const initialState: AppState = {
  repos: [],
  worktrees: [],
  statuses: new Map(),
  containerStatuses: new Map(),
  selectedRepo: null,
  selectedWorktree: null,
  focusedPanel: "repos",
  inputMode: "none",
  dialogType: "none",
  dialogTitle: "",
  dialogMessage: "",
  showDialog: false,
  errorMessage: "",
  statusMessage: "",
  safetyResult: null,
  safetyWorktree: null,
  loading: true,
  activeOperations: [],
  showRepoBrowser: false,
  remoteRepos: [],
  remoteReposLoading: false,
}

const PANELS: Panel[] = ["repos", "worktrees", "detail"]

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "SET_REPOS":
      return { ...state, repos: action.repos, loading: false }

    case "SET_WORKTREES":
      return { ...state, worktrees: action.worktrees, selectedWorktree: null }

    case "SET_STATUSES":
      return { ...state, statuses: action.statuses }

    case "SET_CONTAINER_STATUSES":
      return { ...state, containerStatuses: action.statuses }

    case "SELECT_REPO":
      return { ...state, selectedRepo: action.repo }

    case "SELECT_WORKTREE":
      return { ...state, selectedWorktree: action.worktree }

    case "SET_FOCUSED_PANEL":
      return { ...state, focusedPanel: action.panel }

    case "CYCLE_PANEL_FORWARD": {
      const idx = PANELS.indexOf(state.focusedPanel)
      return { ...state, focusedPanel: PANELS[(idx + 1) % PANELS.length] }
    }

    case "CYCLE_PANEL_BACKWARD": {
      const idx = PANELS.indexOf(state.focusedPanel)
      return { ...state, focusedPanel: PANELS[(idx + PANELS.length - 1) % PANELS.length] }
    }

    case "SET_INPUT_MODE":
      return { ...state, inputMode: action.mode, errorMessage: "" }

    case "SHOW_DIALOG":
      return {
        ...state,
        showDialog: true,
        dialogType: action.dialogType,
        dialogTitle: action.title,
        dialogMessage: action.message,
      }

    case "CLOSE_DIALOG":
      return {
        ...state,
        showDialog: false,
        dialogType: "none",
        dialogTitle: "",
        dialogMessage: "",
        safetyResult: null,
        safetyWorktree: null,
      }

    case "SET_ERROR":
      return { ...state, errorMessage: action.message, statusMessage: "", loading: false }

    case "SET_STATUS":
      return { ...state, statusMessage: action.message, errorMessage: "" }

    case "APPEND_STATUS_DETAIL":
      return {
        ...state,
        statusMessage: state.statusMessage
          ? `${state.statusMessage} ${action.message}`
          : action.message,
        errorMessage: "",
      }

    case "CLEAR_MESSAGES":
      return { ...state, errorMessage: "", statusMessage: "" }

    case "SET_SAFETY_RESULT":
      return {
        ...state,
        safetyResult: action.result,
        safetyWorktree: action.worktree,
      }

    case "SET_LOADING":
      return { ...state, loading: action.loading }

    case "BEGIN_ACTIVITY":
      return { ...state, activeOperations: [...state.activeOperations, action.activity] }

    case "END_ACTIVITY":
      return {
        ...state,
        activeOperations: state.activeOperations.filter((activity) => activity.id !== action.id),
      }

    case "SHOW_REPO_BROWSER":
      return { ...state, showRepoBrowser: true }

    case "HIDE_REPO_BROWSER":
      return { ...state, showRepoBrowser: false, remoteRepos: [], remoteReposLoading: false }

    case "SET_REMOTE_REPOS":
      return { ...state, remoteRepos: action.repos, remoteReposLoading: false }

    case "SET_REMOTE_REPOS_LOADING":
      return { ...state, remoteReposLoading: true }

    case "SET_REMOTE_REPO_STATUS":
      return {
        ...state,
        remoteRepos: state.remoteRepos.map((r) =>
          r.remote.fullName === action.fullName ? { ...r, availability: action.availability } : r,
        ),
      }

    default:
      return state
  }
}
