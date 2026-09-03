import type { Action, AppState, Pane, Store } from "../core/app.ts";
import { defaultConfig } from "../core/types.ts";
import { prsInScope, visibleRepoItems, visibleWorktrees } from "./selectors.ts";

function initialState(initial: Partial<AppState> = {}): AppState {
  return {
    contexts: [],
    repos: [],
    clones: [],
    worktrees: [],
    statuses: {},
    screen: "main",
    prTab: "mine",
    prCursor: 0,
    prFilter: "",
    prScope: { kind: "all" },
    prs: { mine: {}, review: {} },
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
    ? visibleRepoItems(state).length
    : Math.max(0, visibleWorktrees(state).length - 1);
}

function clampCursors(state: AppState): AppState {
  const repoCursor = clamp(state.repoCursor, cursorMaximum(state, "repos"));
  const withRepo = { ...state, repoCursor };
  const worktreeCursor = clamp(withRepo.worktreeCursor, cursorMaximum(withRepo, "worktrees"));
  const withWorktree = { ...withRepo, worktreeCursor };
  const prCursor = clamp(
    withWorktree.prCursor,
    Math.max(0, prsInScope(withWorktree, withWorktree.prTab).length - 1),
  );
  return { ...withWorktree, prCursor };
}

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "hydrate":
      return clampCursors({ ...state, ...action.state });
    case "statuses":
      return { ...state, statuses: action.statuses };
    case "move": {
      if (state.screen === "prs") {
        const next = clamp(
          state.prCursor + action.delta,
          Math.max(0, prsInScope(state, state.prTab).length - 1),
        );
        return { ...state, prCursor: next };
      }
      const pane = action.pane ?? state.pane;
      const cursor = pane === "repos" ? state.repoCursor : state.worktreeCursor;
      const next = clamp(cursor + action.delta, cursorMaximum(state, pane));
      return pane === "repos"
        ? clampCursors({ ...state, repoCursor: next })
        : { ...state, worktreeCursor: next };
    }
    case "moveTo": {
      if (state.screen === "prs") {
        const next = clamp(action.index, Math.max(0, prsInScope(state, state.prTab).length - 1));
        return { ...state, prCursor: next };
      }
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
    case "setScreen":
      return clampCursors({
        ...state,
        screen: action.screen,
        prScope: action.scope ?? state.prScope,
        prCursor: action.cursor ?? state.prCursor,
      });
    case "setPrTab":
      return clampCursors({ ...state, prTab: action.tab, prCursor: 0 });
    case "setPrFilter":
      return clampCursors({ ...state, prFilter: action.filter, prCursor: 0 });
    case "prSlice":
      return clampCursors({
        ...state,
        prs: {
          ...state.prs,
          [action.tab]: { ...state.prs[action.tab], [action.repoId]: action.slice },
        },
      });
    case "setContext":
      return clampCursors({
        ...state,
        activeContextId: action.contextId,
        repoCursor: 0,
        worktreeCursor: 0,
        filter: "",
        ...(state.screen === "prs" ? { prScope: { kind: "all" } as const, prCursor: 0 } : {}),
      });
    case "openDialog":
      return { ...state, dialog: action.dialog, mode: "dialog" };
    case "updateCreateWorktreeBranches": {
      if (state.dialog?.kind !== "create-worktree" || state.dialog.repoId !== action.repoId) {
        return state;
      }
      if (state.dialog.generation !== action.generation) return state;
      return {
        ...state,
        dialog: {
          ...state.dialog,
          branches:
            action.branches === undefined
              ? state.dialog.branches
              : [...new Set([...state.dialog.branches, ...action.branches])],
          fetching: action.fetching,
        },
      };
    }
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
