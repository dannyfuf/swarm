import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "../app/store.ts";
import type { AppState } from "../core/app.ts";
import type { WorktreeId, WorktreeStatus } from "../core/types.ts";
import { makeAppState } from "../testing/fixtures.ts";
import { buildScreen, layoutOf, nextScroll, worktreeColumns } from "./screen.ts";
import { lineText, lineWidth } from "./text.ts";
import { theme } from "./theme.ts";

const NOW = Date.parse("2026-09-02T12:00:00.000Z");

const statuses: Record<WorktreeId, WorktreeStatus> = {
  "bukhr/payroll#main": {
    worktreeId: "bukhr/payroll#main",
    session: "attached",
    windows: [{ index: 1, name: "cc", command: "claude", keepAlive: ["claude"] }],
    running: ["claude"],
  },
  "bukhr/payroll#feat-payroll-fix": {
    worktreeId: "bukhr/payroll#feat-payroll-fix",
    session: "detached",
    windows: [],
    running: ["claude", ":3000"],
  },
};

function stateWith(overrides: Partial<AppState> = {}): AppState {
  const store = createStore({ ...makeAppState(), statuses, ...overrides });
  return store.getState();
}

function context(overrides: Partial<Parameters<typeof buildScreen>[1]> = {}) {
  return {
    width: 120,
    height: 36,
    now: NOW,
    tick: 0,
    home: "/home/test",
    repoScroll: 0,
    worktreeScroll: 0,
    ghosted: false,
    ...overrides,
  };
}

test("layout splits the frame and reserves the chrome rows", () => {
  const layout = layoutOf(120, 36);
  assert.equal(layout.leftWidth + layout.rightWidth + 1, layout.width - 2);
  assert.equal(layout.bodyRows, 36 - 7);
  assert.equal(layout.listRows + layout.detailRows + 1, layout.bodyRows);
  assert.equal(layout.rightColumn, 1 + layout.leftWidth + 1);
});

test("layout drops the detail box on very short terminals", () => {
  const layout = layoutOf(80, 14);
  assert.equal(layout.detailRows, 0);
  assert.equal(layout.listRows, layout.bodyRows);
});

test("worktree columns keep a gutter and shed columns as width shrinks", () => {
  for (const width of [40, 46, 60, 73, 88, 120, 133]) {
    const columns = worktreeColumns(width);
    const used =
      3 +
      columns.branch +
      columns.slack +
      (columns.running > 0 ? columns.running + 1 : 0) +
      1 +
      columns.time;
    assert.ok(used <= width, `columns overflow at ${width}`);
  }
  assert.equal(worktreeColumns(40).running, 0);
  assert.equal(worktreeColumns(73).running, 18);
  assert.ok(worktreeColumns(133).slack > 0);
});

test("nextScroll keeps the viewport still until the cursor nears an edge", () => {
  assert.equal(nextScroll(0, 3, 10, 4), 0, "no scrolling when everything fits");
  assert.equal(nextScroll(0, 5, 10, 40), 0, "cursor comfortably inside the window");
  assert.equal(nextScroll(0, 9, 10, 40), 2, "cursor within scrolloff of the bottom");
  assert.equal(nextScroll(10, 10, 10, 40), 8, "cursor within scrolloff of the top");
  assert.equal(nextScroll(0, 39, 10, 40), 30, "clamped to the last page");
});

test("every screen line is exactly the terminal width", () => {
  for (const [width, height] of [
    [100, 30],
    [120, 36],
    [160, 45],
  ] as const) {
    const lines = buildScreen(stateWith(), context({ width, height }));
    assert.equal(lines.length, height, `line count at ${width}x${height}`);
    for (const [index, line] of lines.entries()) {
      assert.equal(lineWidth(line), width, `line ${index} at ${width}x${height}`);
    }
  }
});

test("the frame junctions line up with the pane divider", () => {
  const lines = buildScreen(stateWith(), context());
  const layout = layoutOf(120, 36);
  assert.ok(lineText(lines[0] ?? []).startsWith("╭─ swarm "));
  assert.equal(lineText(lines[2] ?? "")[layout.rightColumn - 1], "┬");
  assert.equal(lineText(lines[33] ?? "")[layout.rightColumn - 1], "┴");
  assert.equal(lineText(lines[3] ?? "")[layout.rightColumn - 1], "│");
  assert.ok(lineText(lines[35] ?? []).startsWith("╰"));
});

test("worktree rows carry the state glyph, running labels and recency", () => {
  const lines = buildScreen(stateWith(), context()).map(lineText);
  const row = lines.find((line) => line.includes("payroll · main"));
  assert.ok(row, "expected a row for payroll/main");
  assert.ok(row.includes("●"), "attached glyph");
  assert.ok(row.includes("claude"), "running label");
  assert.ok(/\d+[mhdwy] ago/.test(row), "relative time");
  assert.ok(!row.includes("origin/main"), "base ref belongs in the detail box");
});

test("the header summarises live and sleeping sessions", () => {
  const header = lineText(buildScreen(stateWith(), context())[1] ?? []);
  assert.ok(header.includes("1 Buk"));
  assert.ok(header.includes("2 Personal"));
  assert.ok(header.includes("1 live"));
  assert.ok(header.includes("1 sleeping"));
});

test("the cursor row is the only one with the focused highlight", () => {
  const state = stateWith({ pane: "worktrees", worktreeCursor: 2 });
  const lines = buildScreen(state, context());
  const highlighted = lines.filter((line) => line.some((part) => part.bg === theme.cursorBg));
  assert.equal(highlighted.length, 1);
  assert.ok(lineText(highlighted[0] ?? []).includes("feat/payroll-fix"));
});

test("an unfocused pane uses the muted cursor highlight", () => {
  const lines = buildScreen(stateWith({ pane: "repos" }), context());
  assert.equal(lines.filter((line) => line.some((part) => part.bg === theme.cursorBg)).length, 1);
  assert.equal(
    lines.filter((line) => line.some((part) => part.bg === theme.cursorBgBlur)).length,
    1,
  );
});

test("filtering shows the query, the match count and highlights the match", () => {
  const state = stateWith({ mode: "filter", filter: "pay" });
  const lines = buildScreen(state, context());
  const header = lineText(lines[3] ?? []);
  assert.ok(header.includes("/"), "filter prompt");
  assert.ok(header.includes("of"), "match count");
  const rows = lines.filter((line) => lineText(line).includes("feat/payroll-fix"));
  assert.ok(rows.some((row) => row.some((part) => part.fg === theme.yellow && part.bold)));
});

test("an empty context explains the next keystroke", () => {
  const lines = buildScreen(stateWith({ repos: [], worktrees: [], statuses: {} }), context()).map(
    lineText,
  );
  assert.ok(lines.some((line) => line.includes("No repos in Buk")));
  assert.ok(lines.some((line) => line.includes("clone one")));
});

test("a filter with no match points at Esc", () => {
  const lines = buildScreen(stateWith({ filter: "zzzz" }), context()).map(lineText);
  assert.ok(lines.some((line) => line.includes("Nothing matches")));
  assert.ok(lines.some((line) => line.includes("clear the filter")));
});

test("in-flight operations replace the row columns with a spinner and step", () => {
  const state = stateWith({
    operations: [
      {
        id: "op1",
        label: "Creating worktree",
        step: "Copying tree",
        log: ["Receiving objects"],
        targetId: "bukhr/payroll#feat-payroll-fix",
        startedAt: NOW,
      },
    ],
  });
  const lines = buildScreen(state, context()).map(lineText);
  const row = lines.find((line) => line.includes("feat/payroll-fix") && line.includes("Copying"));
  assert.ok(row, "expected the operation row");
  assert.ok(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(row));
  const footer = lines[34] ?? "";
  assert.ok(footer.includes("Creating worktree"));
  assert.ok(footer.includes("Receiving objects"));
});

test("toasts take over the footer", () => {
  const state = stateWith({
    toasts: [{ id: "t1", level: "success", text: "Path copied" }],
  });
  assert.ok(lineText(buildScreen(state, context())[34] ?? []).includes("Path copied"));
});

test("the detail box describes the selected worktree", () => {
  const lines = buildScreen(stateWith({ worktreeCursor: 0 }), context()).map(lineText);
  assert.ok(lines.some((line) => line.includes("base origin/main")));
  assert.ok(lines.some((line) => line.includes("~/.swarm/worktrees/")));
  assert.ok(lines.some((line) => line.includes("windows")));
});

test("ghosting flattens every colour while a dialog is open", () => {
  const lines = buildScreen(stateWith(), context({ ghosted: true }));
  for (const line of lines) {
    for (const part of line) {
      assert.equal(part.fg, theme.ghost);
      assert.equal(part.bg, undefined);
    }
  }
});
