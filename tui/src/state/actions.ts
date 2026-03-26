/**
 * Application state action types for the reducer.
 *
 * Defines all possible state transitions in the Swarm TUI,
 * including panel focus, selection, dialogs, input mode, and messages.
 */

import type { Repo } from "../types/repo.js"
import type { CheckResult } from "../types/safety.js"
import type { Status } from "../types/status.js"
import type { Worktree } from "../types/worktree.js"

/** The three navigable panels in the TUI. */
export type Panel = "repos" | "worktrees" | "detail"

/** Whether the user is in text input mode. */
export type InputMode = "none" | "create"

/** Which dialog is currently displayed. */
export type DialogType = "none" | "delete" | "orphanCleanup" | "pruneOrphans" | "help"

/** Discriminated union of all actions the reducer handles. */
export type AppAction =
  | { type: "SET_REPOS"; repos: Repo[] }
  | { type: "SET_WORKTREES"; worktrees: Worktree[] }
  | { type: "SET_STATUSES"; statuses: Map<string, Status> }
  | { type: "SELECT_REPO"; repo: Repo }
  | { type: "SELECT_WORKTREE"; worktree: Worktree }
  | { type: "SET_FOCUSED_PANEL"; panel: Panel }
  | { type: "CYCLE_PANEL_FORWARD" }
  | { type: "CYCLE_PANEL_BACKWARD" }
  | { type: "SET_INPUT_MODE"; mode: InputMode }
  | { type: "SHOW_DIALOG"; dialogType: DialogType; title: string; message: string }
  | { type: "CLOSE_DIALOG" }
  | { type: "SET_ERROR"; message: string }
  | { type: "SET_STATUS"; message: string }
  | { type: "CLEAR_MESSAGES" }
  | { type: "SET_SAFETY_RESULT"; result: CheckResult; worktree: Worktree }
  | { type: "SET_LOADING"; loading: boolean }
