import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AppState, Operation } from "../core/app.ts";
import { defaultConfig, type WorktreeStatus } from "../core/types.ts";
import { makeAppState } from "../testing/fixtures.ts";
import { selectedRepo, selectedWorktree, visibleRepos, visibleWorktrees } from "./selectors.ts";
import { createStore, reduce } from "./store.ts";

function state(overrides: Partial<AppState> = {}): AppState {
  return createStore(makeAppState(overrides)).getState();
}

describe("selectors", () => {
  test("filters and sorts repos in the active context", () => {
    const current = state();
    assert.deepEqual(
      visibleRepos(current).map((repo) => repo.name),
      ["payroll", "platform"],
    );
    assert.equal(selectedRepo(current), undefined);
    assert.equal(selectedRepo({ ...current, repoCursor: 2 })?.id, "bukhr/platform");
  });

  test("shows all context worktrees by recency for the All row", () => {
    assert.deepEqual(
      visibleWorktrees(state()).map((worktree) => worktree.id),
      [
        "bukhr/platform#feat-api",
        "bukhr/payroll#main",
        "bukhr/payroll#feat-payroll-fix",
        "bukhr/payroll#fix-1234",
      ],
    );
  });

  test("limits worktrees to a selected repo and applies fuzzy filtering", () => {
    const current = state({ repoCursor: 1, filter: "pay" });
    assert.deepEqual(
      visibleWorktrees(current).map((worktree) => worktree.branch),
      ["feat/payroll-fix"],
    );
    assert.equal(selectedWorktree(current)?.id, "bukhr/payroll#feat-payroll-fix");
  });
});

describe("reduce", () => {
  test("hydrates state and clamps cursors against the resulting lists", () => {
    const result = reduce(state({ repoCursor: 2, worktreeCursor: 3 }), {
      type: "hydrate",
      state: { repos: [], worktrees: [], loading: false },
    });
    assert.equal(result.loading, false);
    assert.equal(result.repoCursor, 0);
    assert.equal(result.worktreeCursor, 0);
  });

  test("replaces statuses", () => {
    const status: WorktreeStatus = {
      worktreeId: "bukhr/payroll#main",
      session: "attached",
      windows: [],
      running: ["claude"],
    };
    const result = reduce(state(), {
      type: "statuses",
      statuses: { [status.worktreeId]: status },
    });
    assert.equal(result.statuses[status.worktreeId], status);
  });

  test("moves each cursor and clamps without wrapping", () => {
    let current = state();
    current = reduce(current, { type: "move", pane: "repos", delta: 99 });
    assert.equal(current.repoCursor, 2);
    assert.equal(current.worktreeCursor, 0);
    current = reduce(current, { type: "move", pane: "repos", delta: -99 });
    assert.equal(current.repoCursor, 0);
    current = reduce(current, { type: "move", delta: 99 });
    assert.equal(current.worktreeCursor, 3);
    current = reduce(current, { type: "move", delta: -99 });
    assert.equal(current.worktreeCursor, 0);
  });

  test("moves directly and clamps indexes", () => {
    let current = reduce(state(), { type: "moveTo", pane: "repos", index: 1 });
    assert.equal(current.repoCursor, 1);
    current = reduce(current, { type: "moveTo", pane: "worktrees", index: 99 });
    assert.equal(current.worktreeCursor, 2);
    current = reduce(current, { type: "moveTo", index: -10 });
    assert.equal(current.worktreeCursor, 0);
  });

  test("focuses panes and changes mode", () => {
    let current = reduce(state(), { type: "focus", pane: "repos" });
    assert.equal(current.pane, "repos");
    current = reduce(current, { type: "setMode", mode: "filter" });
    assert.equal(current.mode, "filter");
  });

  test("sets filters and resets the worktree cursor", () => {
    const result = reduce(state({ worktreeCursor: 2 }), { type: "setFilter", filter: "pay" });
    assert.equal(result.filter, "pay");
    assert.equal(result.worktreeCursor, 0);
  });

  test("changes context and resets navigation state", () => {
    const result = reduce(state({ repoCursor: 2, worktreeCursor: 2, filter: "pay" }), {
      type: "setContext",
      contextId: "personal",
    });
    assert.equal(result.activeContextId, "personal");
    assert.equal(result.repoCursor, 0);
    assert.equal(result.worktreeCursor, 0);
    assert.equal(result.filter, "");
  });

  test("opens and closes dialogs while synchronizing mode", () => {
    const dialog = { kind: "help" } as const;
    let current = reduce(state(), { type: "openDialog", dialog });
    assert.equal(current.dialog, dialog);
    assert.equal(current.mode, "dialog");
    current = reduce(current, { type: "closeDialog" });
    assert.equal(current.dialog, undefined);
    assert.equal(current.mode, "normal");
  });

  test("starts, advances, logs, and ends operations", () => {
    const operation: Operation = {
      id: "op-1",
      label: "Clone",
      step: "Starting",
      log: [],
      startedAt: 1,
    };
    let current = reduce(state(), { type: "opStart", op: operation });
    assert.deepEqual(current.operations, [operation]);
    current = reduce(current, { type: "opStep", id: "op-1", step: "Copying", line: "50%" });
    assert.equal(current.operations[0]?.step, "Copying");
    assert.deepEqual(current.operations[0]?.log, ["50%"]);
    current = reduce(current, { type: "opEnd", id: "op-1" });
    assert.deepEqual(current.operations, []);
  });

  test("caps noisy operation logs", () => {
    let current = reduce(state(), {
      type: "opStart",
      op: { id: "op-1", label: "Clone", step: "Starting", log: [], startedAt: 1 },
    });
    for (let index = 0; index < 205; index += 1) {
      current = reduce(current, { type: "opStep", id: "op-1", step: "Clone", line: `${index}` });
    }

    assert.equal(current.operations[0]?.log.length, 200);
    assert.equal(current.operations[0]?.log[0], "5");
  });

  test("caps toasts at three and dismisses by id", () => {
    let current = state();
    for (let index = 1; index <= 4; index += 1) {
      current = reduce(current, {
        type: "toast",
        toast: { id: `${index}`, level: "info", text: `${index}` },
      });
    }
    assert.deepEqual(
      current.toasts.map((toast) => toast.id),
      ["2", "3", "4"],
    );
    current = reduce(current, { type: "dismissToast", id: "3" });
    assert.deepEqual(
      current.toasts.map((toast) => toast.id),
      ["2", "4"],
    );
  });

  test("sets and clears errors", () => {
    let current = reduce(state(), { type: "setError", error: "broken" });
    assert.equal(current.error, "broken");
    current = reduce(current, { type: "setError" });
    assert.equal(current.error, undefined);
  });

  test("sets config and the current session", () => {
    const config = defaultConfig("/tmp/swarm");
    let current = reduce(state(), { type: "setConfig", config });
    assert.equal(current.config, config);
    current = reduce(current, { type: "setCurrentSession", session: "payroll/main" });
    assert.equal(current.currentSession, "payroll/main");
    current = reduce(current, { type: "setCurrentSession" });
    assert.equal(current.currentSession, undefined);
  });
});

describe("createStore", () => {
  test("publishes updated state and supports unsubscribe", () => {
    const store = createStore(makeAppState());
    const seen: AppState[] = [];
    const unsubscribe = store.subscribe((next) => seen.push(next));
    store.dispatch({ type: "focus", pane: "repos" });
    unsubscribe();
    store.dispatch({ type: "focus", pane: "worktrees" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.pane, "repos");
  });
});
