import type { Action, AppState, Pane, Store } from "../core/app.ts";
import { defaultConfig } from "../core/types.ts";
import { visibleRepos, visibleWorktrees } from "./selectors.ts";

function initialState(initial: Partial<AppState> = {}): AppState {
  return {
    contexts: [],
    repos: [],
    worktrees: [],
    statuses: {},
    pane: "worktrees",
    mode: "normal",
    repoCursor: 0,
    worktreeCursor: 0,
    filter: "",
    operations: [],
    toasts: [],
    loading: true,
    config: defaultConfig(".swarm"),
    ...initial,
  };
}

function clamp(value: number, maximum: number): number {
  return Math.max(0, Math.min(value, Math.max(0, maximum)));
}

function cursorMaximum(state: AppState, pane: Pane): number {
  return pane === "repos"
    ? visibleRepos(state).length
    : Math.max(0, visibleWorktrees(state).length - 1);
}

function clampCursors(state: AppState): AppState {
  const repoCursor = clamp(state.repoCursor, cursorMaximum(state, "repos"));
  const withRepo = { ...state, repoCursor };
  const worktreeCursor = clamp(withRepo.worktreeCursor, cursorMaximum(withRepo, "worktrees"));
  return { ...withRepo, worktreeCursor };
}

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "hydrate":
      return clampCursors({ ...state, ...action.state });
    case "statuses":
      return { ...state, statuses: action.statuses };
    case "move": {
      const pane = action.pane ?? state.pane;
      const cursor = pane === "repos" ? state.repoCursor : state.worktreeCursor;
      const next = clamp(cursor + action.delta, cursorMaximum(state, pane));
      return pane === "repos"
        ? clampCursors({ ...state, repoCursor: next })
        : { ...state, worktreeCursor: next };
    }
    case "moveTo": {
      const pane = action.pane ?? state.pane;
      const next = clamp(action.index, cursorMaximum(state, pane));
      return pane === "repos"
        ? clampCursors({ ...state, repoCursor: next })
        : { ...state, worktreeCursor: next };
    }
    case "focus":
      return { ...state, pane: action.pane };
    case "setMode":
      return { ...state, mode: action.mode };
    case "setFilter":
      return clampCursors({ ...state, filter: action.filter, worktreeCursor: 0 });
    case "setContext":
      return clampCursors({
        ...state,
        activeContextId: action.contextId,
        repoCursor: 0,
        worktreeCursor: 0,
        filter: "",
      });
    case "openDialog":
      return { ...state, dialog: action.dialog, mode: "dialog" };
    case "closeDialog":
      return { ...state, dialog: undefined, mode: "normal" };
    case "opStart":
      return {
        ...state,
        operations: [...state.operations.filter((op) => op.id !== action.op.id), action.op],
      };
    case "opStep":
      return {
        ...state,
        operations: state.operations.map((operation) =>
          operation.id === action.id
            ? {
                ...operation,
                step: action.step,
                log:
                  action.line === undefined
                    ? operation.log
                    : [...operation.log, action.line].slice(-200),
              }
            : operation,
        ),
      };
    case "opEnd":
      return {
        ...state,
        operations: state.operations.filter((operation) => operation.id !== action.id),
      };
    case "toast":
      return { ...state, toasts: [...state.toasts, action.toast].slice(-3) };
    case "dismissToast":
      return { ...state, toasts: state.toasts.filter((toast) => toast.id !== action.id) };
    case "setError":
      return { ...state, error: action.error };
    case "setConfig":
      return { ...state, config: action.config };
    case "setCurrentSession":
      return { ...state, currentSession: action.session };
  }
}

export function createStore(initial: Partial<AppState> = {}): Store {
  let state = clampCursors(initialState(initial));
  const listeners = new Set<(state: AppState) => void>();

  return {
    getState() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch(action) {
      state = reduce(state, action);
      for (const listener of listeners) listener(state);
    },
  };
}
