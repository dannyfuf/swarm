import { describe, expect, test } from "bun:test"
import type { AppAction } from "../../state/actions.js"
import { type AppState, appReducer, initialState } from "../../state/appReducer.js"
import type { Repo } from "../../types/repo.js"
import type { Worktree } from "../../types/worktree.js"

const mockRepo: Repo = {
  name: "test-repo",
  path: "/home/user/repos/test-repo",
  defaultBranch: "main",
  lastScanned: new Date("2026-01-01"),
}

const mockWorktree: Worktree = {
  slug: "feature_auth",
  branch: "feature/auth",
  path: "/home/user/repos/test-repo__wt__feature_auth",
  repoName: "test-repo",
  createdAt: new Date("2026-01-01"),
  lastOpenedAt: new Date("2026-01-02"),
  tmuxSession: "test-repo--wt--feature_auth",
  isOrphaned: false,
}

describe("appReducer", () => {
  test("initial state has correct defaults", () => {
    expect(initialState.repos).toEqual([])
    expect(initialState.worktrees).toEqual([])
    expect(initialState.selectedRepo).toBeNull()
    expect(initialState.selectedWorktree).toBeNull()
    expect(initialState.focusedPanel).toBe("repos")
    expect(initialState.inputMode).toBe("none")
    expect(initialState.showDialog).toBe(false)
    expect(initialState.loading).toBe(true)
  })

  test("SET_REPOS updates repos and clears loading", () => {
    const state = appReducer(initialState, {
      type: "SET_REPOS",
      repos: [mockRepo],
    })
    expect(state.repos).toEqual([mockRepo])
    expect(state.loading).toBe(false)
  })

  test("SET_WORKTREES updates worktrees and clears selection", () => {
    const stateWithSelection: AppState = {
      ...initialState,
      selectedWorktree: mockWorktree,
    }
    const state = appReducer(stateWithSelection, {
      type: "SET_WORKTREES",
      worktrees: [mockWorktree],
    })
    expect(state.worktrees).toEqual([mockWorktree])
    expect(state.selectedWorktree).toBeNull()
  })

  test("SET_STATUSES updates statuses map", () => {
    const statuses = new Map([
      [
        "/path",
        {
          hasChanges: true,
          hasUnpushed: false,
          branchMerged: null,
          isOrphaned: false,
          computedAt: new Date(),
        },
      ],
    ])
    const state = appReducer(initialState, { type: "SET_STATUSES", statuses })
    expect(state.statuses).toBe(statuses)
  })

  test("SELECT_REPO sets selected repo", () => {
    const state = appReducer(initialState, { type: "SELECT_REPO", repo: mockRepo })
    expect(state.selectedRepo).toBe(mockRepo)
  })

  test("SELECT_WORKTREE sets selected worktree", () => {
    const state = appReducer(initialState, {
      type: "SELECT_WORKTREE",
      worktree: mockWorktree,
    })
    expect(state.selectedWorktree).toBe(mockWorktree)
  })

  test("SET_FOCUSED_PANEL changes focused panel", () => {
    const state = appReducer(initialState, {
      type: "SET_FOCUSED_PANEL",
      panel: "worktrees",
    })
    expect(state.focusedPanel).toBe("worktrees")
  })

  test("CYCLE_PANEL_FORWARD cycles repos -> worktrees -> detail -> repos", () => {
    let state = appReducer(initialState, { type: "CYCLE_PANEL_FORWARD" })
    expect(state.focusedPanel).toBe("worktrees")

    state = appReducer(state, { type: "CYCLE_PANEL_FORWARD" })
    expect(state.focusedPanel).toBe("detail")

    state = appReducer(state, { type: "CYCLE_PANEL_FORWARD" })
    expect(state.focusedPanel).toBe("repos")
  })

  test("CYCLE_PANEL_BACKWARD cycles repos -> detail -> worktrees -> repos", () => {
    let state = appReducer(initialState, { type: "CYCLE_PANEL_BACKWARD" })
    expect(state.focusedPanel).toBe("detail")

    state = appReducer(state, { type: "CYCLE_PANEL_BACKWARD" })
    expect(state.focusedPanel).toBe("worktrees")

    state = appReducer(state, { type: "CYCLE_PANEL_BACKWARD" })
    expect(state.focusedPanel).toBe("repos")
  })

  test("SET_INPUT_MODE changes input mode and clears errors", () => {
    const stateWithError: AppState = {
      ...initialState,
      errorMessage: "some error",
    }
    const state = appReducer(stateWithError, {
      type: "SET_INPUT_MODE",
      mode: "create",
    })
    expect(state.inputMode).toBe("create")
    expect(state.errorMessage).toBe("")
  })

  test("SHOW_DIALOG opens dialog with type, title, message", () => {
    const state = appReducer(initialState, {
      type: "SHOW_DIALOG",
      dialogType: "delete",
      title: "Delete?",
      message: "Are you sure?",
    })
    expect(state.showDialog).toBe(true)
    expect(state.dialogType).toBe("delete")
    expect(state.dialogTitle).toBe("Delete?")
    expect(state.dialogMessage).toBe("Are you sure?")
  })

  test("CLOSE_DIALOG resets all dialog and safety state", () => {
    const stateWithDialog: AppState = {
      ...initialState,
      showDialog: true,
      dialogType: "delete",
      dialogTitle: "Delete?",
      dialogMessage: "Sure?",
      safetyResult: {
        safe: true,
        warnings: [],
        blockers: [],
        metadata: {
          checkedAt: new Date(),
          uncommittedFiles: 0,
          unpushedCommits: 0,
          branchMerged: null,
        },
      },
      safetyWorktree: mockWorktree,
    }
    const state = appReducer(stateWithDialog, { type: "CLOSE_DIALOG" })
    expect(state.showDialog).toBe(false)
    expect(state.dialogType).toBe("none")
    expect(state.dialogTitle).toBe("")
    expect(state.dialogMessage).toBe("")
    expect(state.safetyResult).toBeNull()
    expect(state.safetyWorktree).toBeNull()
  })

  test("SET_ERROR sets error and clears status and loading", () => {
    const stateWithStatus: AppState = {
      ...initialState,
      statusMessage: "all good",
      loading: true,
    }
    const state = appReducer(stateWithStatus, {
      type: "SET_ERROR",
      message: "something broke",
    })
    expect(state.errorMessage).toBe("something broke")
    expect(state.statusMessage).toBe("")
    expect(state.loading).toBe(false)
  })

  test("SET_STATUS sets status and clears error", () => {
    const stateWithError: AppState = {
      ...initialState,
      errorMessage: "previous error",
    }
    const state = appReducer(stateWithError, {
      type: "SET_STATUS",
      message: "all good",
    })
    expect(state.statusMessage).toBe("all good")
    expect(state.errorMessage).toBe("")
  })

  test("CLEAR_MESSAGES clears both error and status", () => {
    const state = appReducer(
      { ...initialState, errorMessage: "err", statusMessage: "stat" },
      { type: "CLEAR_MESSAGES" },
    )
    expect(state.errorMessage).toBe("")
    expect(state.statusMessage).toBe("")
  })

  test("SET_SAFETY_RESULT stores safety result and worktree", () => {
    const result = {
      safe: true,
      warnings: [],
      blockers: [],
      metadata: {
        checkedAt: new Date(),
        uncommittedFiles: 0,
        unpushedCommits: 0,
        branchMerged: null,
      },
    }
    const state = appReducer(initialState, {
      type: "SET_SAFETY_RESULT",
      result,
      worktree: mockWorktree,
    })
    expect(state.safetyResult).toBe(result)
    expect(state.safetyWorktree).toBe(mockWorktree)
  })

  test("SET_LOADING updates loading flag", () => {
    const state = appReducer(initialState, { type: "SET_LOADING", loading: false })
    expect(state.loading).toBe(false)
  })

  test("returns same state for unknown action", () => {
    const state = appReducer(initialState, { type: "UNKNOWN" } as unknown as AppAction)
    expect(state).toBe(initialState)
  })
})
