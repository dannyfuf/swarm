import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "../app/store.ts";
import type { AppState } from "../core/app.ts";
import type { PrRepoSlice, PullRequest, WorktreeId, WorktreeStatus } from "../core/types.ts";
import { makeAppState, pullRequest } from "../testing/fixtures.ts";
import {
  buildScreen,
  fitHints,
  hintsWidth,
  layoutOf,
  nextScroll,
  prColumns,
  worktreeColumns,
} from "./screen.ts";
import { lineText, lineWidth } from "./text.ts";
import { glyphs, theme } from "./theme.ts";

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
    prScroll: 0,
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

test("worktree rows show a host badge only for remote worktrees", () => {
  const state = stateWith({
    worktrees: stateWith().worktrees.map((worktree) =>
      worktree.id === "bukhr/payroll#feat-payroll-fix" ? { ...worktree, host: "devbox" } : worktree,
    ),
  });
  const lines = buildScreen(state, context()).map(lineText);
  const remote = lines.find((line) => line.includes("feat/payroll-fix"));
  const local = lines.find((line) => line.includes("payroll · main"));
  assert.ok(remote?.includes("@devbox"), remote ?? "remote row missing");
  assert.ok(local && !local.includes("@"), local ?? "local row missing");
});

test("remote details show host, prefixed path, and the host error", () => {
  const remote = {
    ...stateWith().worktrees[0],
    host: "devbox",
    path: "/srv/swarm/worktrees/bukhr/payroll/main",
  };
  assert.ok(remote);
  const state = stateWith({
    worktrees: [remote],
    statuses: {
      [remote.id]: { worktreeId: remote.id, session: "unknown", windows: [], running: [] },
    },
    remoteErrors: { devbox: "ssh connection timed out" },
  });
  const lines = buildScreen(state, context()).map(lineText);
  assert.ok(lines.some((line) => line.includes("host: devbox")));
  assert.ok(lines.some((line) => line.includes("devbox:/srv/swarm/worktrees/bukhr/payroll/main")));
  assert.ok(lines.some((line) => line.includes("offline: ssh connection timed out")));
});

test("unknown sessions render offline in row and aggregate counts", () => {
  const worktree = { ...stateWith().worktrees[0], host: "devbox" };
  assert.ok(worktree);
  const state = stateWith({
    worktrees: [worktree],
    statuses: {
      [worktree.id]: { worktreeId: worktree.id, session: "unknown", windows: [], running: [] },
    },
  });
  const lines = buildScreen(state, context()).map(lineText);
  const row = lines.find((line) => line.includes("@devbox"));
  assert.ok(row?.includes("?"), row ?? "remote row missing");
  assert.ok(lines[1]?.includes("? 1 offline"));
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

test("persisted clone jobs render their background status and log path", () => {
  const state = stateWith({
    repos: [],
    worktrees: [],
    statuses: {},
    pane: "repos",
    repoCursor: 1,
    clones: [
      {
        id: "bukhr/benefits",
        owner: "bukhr",
        name: "benefits",
        url: "git@github.com:bukhr/benefits.git",
        contextId: "buk",
        defaultBranch: "main",
        path: "/home/test/.swarm/repos/bukhr/benefits",
        stagingPath: "/home/test/.swarm/repos/bukhr/benefits.staging",
        logPath: "/home/test/.swarm/logs/clone-benefits.log",
        pid: 4242,
        startedAt: "2026-09-02T11:00:00.000Z",
        status: "cloning",
      },
    ],
  });
  const lines = buildScreen(state, context()).map(lineText);

  assert.ok(lines.some((line) => line.includes("benefits") && line.includes("cloning")));
  assert.ok(lines.some((line) => line.includes("logs/clone-benefits.log")));
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

// ---------------------------------------------------------------------------
// Pull requests screen
// ---------------------------------------------------------------------------

function slice(prs: PullRequest[], overrides: Partial<PrRepoSlice> = {}): PrRepoSlice {
  return { prs, fetchedAt: "2026-09-02T11:58:00.000Z", loading: false, ...overrides };
}

const linkedPr = pullRequest({
  number: 1234,
  title: "feat: add pr integration to swarm",
  headRefName: "feat/payroll-fix",
  author: "dannyfuf",
  reviewDecision: "approved",
  updatedAt: "2026-09-02T10:00:00.000Z",
});

const looseP = pullRequest({
  number: 1201,
  title: "fix: nil guard on payroll export",
  headRefName: "fix/nil-guard",
  author: "dannyfuf",
  checks: "fail",
  updatedAt: "2026-09-01T10:00:00.000Z",
});

const reviewPr = pullRequest({
  repoId: "bukhr/platform",
  number: 877,
  title: "feat: payroll export v2",
  headRefName: "feat/export-v2",
  author: "jperez",
  updatedAt: "2026-09-02T08:00:00.000Z",
});

function prScreen(overrides: Partial<AppState> = {}): AppState {
  return stateWith({
    screen: "prs",
    prs: {
      mine: { "bukhr/payroll": slice([linkedPr, looseP]) },
      review: { "bukhr/platform": slice([reviewPr]) },
    },
    ...overrides,
  });
}

test("the pr screen replaces the panes with one full width body", () => {
  const lines = buildScreen(prScreen(), context());
  for (const [index, line] of lines.entries()) {
    assert.equal(lineWidth(line), 120, `line ${index}`);
  }
  const text = lines.map(lineText);
  assert.ok(!text.some((line) => line.includes("WORKTREES")), "the main body is gone");
  assert.ok(
    text.some((line) => line.includes("1 Buk")),
    "context tabs stay",
  );
  const header = text[3] ?? "";
  assert.ok(header.includes("PULL REQUESTS"));
  assert.ok(header.includes("MINE 2"));
  assert.ok(header.includes("REVIEW 1"));
  assert.ok(header.includes("all repos in Buk"));
  assert.ok(header.includes("updated"));
});

test("pr rows carry the presence glyph, number, title, state word and recency", () => {
  const text = buildScreen(prScreen(), context()).map(lineText);
  const row = text.find((line) => line.includes("#1234"));
  assert.ok(row, "expected the linked PR row");
  assert.ok(row.includes("feat: add pr integration to swarm"));
  assert.ok(row.includes("◌"), "the worktree it is linked to is detached");
  assert.ok(row.includes("approved"));
  assert.ok(row.includes("feat/payroll-fix"));
  assert.ok(/\d+[mhdwy] ago/.test(row));

  const unlinked = text.find((line) => line.includes("#1201"));
  assert.ok(unlinked?.includes("ci ✗"), "checks failing wins over the review decision");
});

test("the active pr tab is the only one underlined and the cursor row is highlighted", () => {
  const lines = buildScreen(prScreen(), context());
  const header = lines[3] ?? [];
  const mine = header.find((part) => part.text === "MINE");
  const review = header.find((part) => part.text === "REVIEW");
  assert.equal(mine?.underline, true);
  assert.notEqual(review?.underline, true);

  const highlighted = lines.filter((line) => line.some((part) => part.bg === theme.cursorBg));
  assert.equal(highlighted.length, 1);
  assert.ok(lineText(highlighted[0] ?? []).includes("#1234"));
});

test("pr columns shed the repo prefix, then the branch, then the author", () => {
  const wide = prColumns(158, { author: true, repo: true });
  assert.equal(wide.showRepo, true);
  assert.ok(wide.branch > 0 && wide.author > 0);

  assert.equal(wide.author, 16, "a wide row fits a full login");

  const medium = prColumns(98, { author: true, repo: true });
  assert.equal(medium.showRepo, false, "the repo prefix goes first");
  assert.ok(medium.branch > 0);
  assert.equal(medium.author, 12, "the author narrows back to a first name");
  assert.equal(prColumns(129, { author: true, repo: true }).author, 12);
  assert.equal(prColumns(130, { author: true, repo: true }).author, 16);

  const narrow = prColumns(68, { author: true, repo: true });
  assert.equal(narrow.branch, 0, "the branch column goes next");
  assert.equal(narrow.author, 0, "and the author with it");

  for (const width of [60, 68, 88, 98, 118, 158]) {
    for (const author of [false, true]) {
      const columns = prColumns(width, { author, repo: true });
      const used =
        5 +
        columns.number +
        2 +
        columns.title +
        (columns.author > 0 ? columns.author + 2 : 0) +
        (columns.branch > 0 ? columns.branch + 2 : 0) +
        2 +
        columns.state +
        1 +
        columns.time +
        1;
      assert.equal(used, Math.max(width, 5 + columns.number + 2 + 10 + 14), `columns at ${width}`);
    }
  }
});

test("the review tab shows the author and hides it again on a narrow terminal", () => {
  const state = prScreen({ prTab: "review" });
  // "ago" pins the assertion to the list row: the detail pane names the author too.
  const rowAt = (width: number) =>
    buildScreen(state, context({ width }))
      .map(lineText)
      .find((line) => line.includes("#877") && line.includes("ago")) ?? "";
  assert.ok(rowAt(120).includes("jperez"));
  assert.ok(!rowAt(68).includes("jperez"));
});

test("an empty pr tab names the scope and the next keystroke", () => {
  const text = buildScreen(prScreen({ prs: { mine: {}, review: {} } }), context()).map(lineText);
  assert.ok(text.some((line) => line.includes("No open PRs authored by you in all repos in Buk")));
  assert.ok(text.some((line) => line.includes("r refresh") && line.includes("Tab REVIEW")));
  assert.ok(
    text.some((line) => line.includes("No PRs waiting")) === false,
    "the other tab's message stays on the other tab",
  );
});

test("a loading scope spins in the tab count and on the freshness label", () => {
  const state = prScreen({
    prs: { mine: { "bukhr/payroll": { prs: [], loading: true } }, review: {} },
  });
  const text = buildScreen(state, context()).map(lineText);
  assert.ok((text[3] ?? "").includes("updating…"));
  assert.ok(/MINE [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(text[3] ?? ""));
});

test("a repo whose fetch failed gets its own row at the bottom of the list", () => {
  const state = prScreen({
    prs: {
      mine: {
        "bukhr/payroll": slice([linkedPr]),
        "bukhr/platform": slice([], { error: "gh: not authenticated" }),
      },
      review: {},
    },
  });
  const text = buildScreen(state, context()).map(lineText);
  const row = text.find((line) => line.includes("⚠"));
  assert.ok(row?.includes("platform · gh: not authenticated"));
});

test("the pr detail pane offers to create the worktree the PR has no link to", () => {
  const text = buildScreen(prScreen({ prCursor: 1 }), context()).map(lineText);
  assert.ok(text.some((line) => line.includes("#1201 fix: nil guard")));
  assert.ok(text.some((line) => line.includes("worktree  none") && line.includes("Enter creates")));
  assert.ok(text.some((line) => line.includes("from origin/fix/nil-guard")));
  assert.ok(text.some((line) => line.includes("https://github.com/")));
});

test("the pr detail pane names the linked worktree and its session", () => {
  const text = buildScreen(prScreen(), context()).map(lineText);
  assert.ok(
    text.some(
      (line) => line.includes("worktree  ~/.swarm/worktrees/") && line.includes("session detached"),
    ),
  );
});

test("the footer's primary action follows the selected row", () => {
  const linked = buildScreen(prScreen(), context()).map(lineText)[34] ?? "";
  assert.ok(linked.includes("Enter open"), linked);
  const loose = buildScreen(prScreen({ prCursor: 1 }), context()).map(lineText)[34] ?? "";
  assert.ok(loose.includes("Enter create worktree"), loose);
});

test("fitHints sheds optional hints by priority instead of clipping", () => {
  const hints = [
    { key: "Enter", label: "create worktree" },
    { key: "O", label: "create, keep previous" },
    { key: "b", label: "browser" },
    { key: "y", label: "copy url" },
    { key: "/", label: "filter" },
    { key: "r", label: "refresh" },
    { key: "Tab", label: "switch tab" },
    { key: "Esc", label: "back" },
    { key: "?", label: "help" },
  ];
  const order = ["O", "b", "y", "/", "r", "Tab"];

  assert.deepEqual(fitHints(hints, 200, order), hints, "nothing is dropped when it all fits");

  // A 100 column terminal leaves 98 cells for the footer.
  const medium = fitHints(hints, 98, order);
  assert.deepEqual(
    medium.map(({ key }) => key),
    ["Enter", "y", "/", "r", "Tab", "Esc", "?"],
  );
  assert.ok(hintsWidth(medium) <= 98, `${hintsWidth(medium)} cells`);

  // A 70 column terminal leaves 68.
  const narrow = fitHints(hints, 68, order);
  assert.deepEqual(
    narrow.map(({ key }) => key),
    ["Enter", "r", "Tab", "Esc", "?"],
  );
  assert.ok(hintsWidth(narrow) <= 68, `${hintsWidth(narrow)} cells`);

  assert.deepEqual(
    fitHints(hints, 10, order).map(({ key }) => key),
    ["Enter", "Esc", "?"],
    "the way out is never dropped, however narrow the row",
  );
});

test("the pr footer keeps back and help on narrow terminals", () => {
  for (const [width, height] of [
    [70, 24],
    [100, 30],
  ] as const) {
    const lines = buildScreen(prScreen({ prCursor: 1 }), context({ width, height }));
    const footer = lineText(lines[height - 2] ?? []);
    assert.equal(footer.length, width, `footer width at ${width}`);
    assert.ok(footer.includes("Enter create worktree"), footer);
    assert.ok(footer.includes("Esc back"), footer);
    assert.ok(footer.includes("? help"), footer);
    assert.ok(!footer.includes("keep previous"), `the O hint goes first at ${width}`);
    assert.ok(!footer.includes(glyphs.ellipsis), `no clipped hint at ${width}`);
  }
});

test("an empty pr list leaves the detail pane blank instead of saying nothing selected", () => {
  const lines = buildScreen(stateWith({ screen: "prs" }), context());
  const text = lines.map(lineText);
  assert.ok(!text.some((line) => line.includes("nothing selected")));
  assert.ok(
    text.some((line) => line.includes("No open PRs")),
    "the body still explains the empty state",
  );
  const layout = layoutOf(120, 36);
  for (let row = 0; row < layout.detailRows; row += 1) {
    const line = text[4 + layout.listRows + 1 + row] ?? "";
    assert.equal(line.slice(1, -1).trim(), "", `detail row ${row} is blank`);
  }
});

test("filtering the pr list highlights the match and counts it in the header", () => {
  const state = prScreen({ mode: "filter", prFilter: "guard" });
  const lines = buildScreen(state, context());
  const header = lineText(lines[3] ?? "");
  assert.ok(header.includes("/"));
  assert.ok(header.includes("1 of 2"));
  const row = lines.find((line) => lineText(line).includes("#1201"));
  assert.ok(row?.some((part) => part.fg === theme.yellow && part.bold));
});

test("worktree rows carry the pr badge and the detail pane spells the PR out", () => {
  const state = stateWith({
    prs: { mine: { "bukhr/payroll": slice([linkedPr]) }, review: {} },
    worktreeCursor: 2,
  });
  const text = buildScreen(state, context()).map(lineText);
  const row = text.find((line) => line.includes("feat/payroll-fix") && line.includes("#1234"));
  assert.ok(row?.includes("#1234 approved"), row ?? "no row for the linked worktree");
  assert.ok(text.some((line) => line.includes("base origin/main · PR #1234 approved")));
  const other = text.find((line) => line.includes("payroll · main "));
  assert.ok(other && !other.includes("#"), "rows without a PR keep the column blank");
});

test("the badge column only exists while some visible row has a pull request", () => {
  const without = buildScreen(stateWith(), context()).map(lineText);
  const withBadge = buildScreen(
    stateWith({ prs: { mine: { "bukhr/payroll": slice([linkedPr]) }, review: {} } }),
    context(),
  ).map(lineText);
  const branchColumn = (lines: string[]) =>
    (lines.find((line) => line.includes("payroll · main")) ?? "").indexOf("claude");
  assert.ok(branchColumn(without) !== branchColumn(withBadge), "the cluster shifts for the badge");
  assert.equal(worktreeColumns(88).badge, 0);
  assert.equal(worktreeColumns(88, true).badge, 15);
  assert.equal(worktreeColumns(40, true).badge, 0, "no badge once the running column is gone");
});

test("the top line counts the pull requests waiting for a review", () => {
  const state = stateWith({
    prs: { mine: {}, review: { "bukhr/platform": slice([reviewPr]) } },
  });
  assert.ok(lineText(buildScreen(state, context())[1] ?? []).includes("1 to review"));
  assert.ok(!lineText(buildScreen(stateWith(), context())[1] ?? []).includes("to review"));
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
