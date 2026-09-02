import { KEY_HINTS } from "../app/keymap.ts";
import {
  isCloneJob,
  type RepoListItem,
  selectedClone,
  selectedRepo,
  selectedWorktree,
  visibleRepoItems,
  visibleRepos,
  visibleWorktrees,
} from "../app/selectors.ts";
import type { AppState, Operation } from "../core/app.ts";
import { fuzzyFilter } from "../core/fuzzy.ts";
import type { SessionState, Worktree } from "../core/types.ts";
import { aggregateSession, relativeTime, runningLabel, stateGlyph, tildePath } from "./format.ts";
import {
  type Cell,
  cell,
  fitLine,
  ghostLine,
  highlight,
  type Line,
  pad,
  padStart,
  repeat,
  spread,
  truncate,
  truncateStart,
  withBackground,
} from "./text.ts";
import { box, glyphs, spinnerFrame, theme } from "./theme.ts";

export interface ScreenLayout {
  width: number;
  height: number;
  /** Content width of the repos pane (between the left border and the divider). */
  leftWidth: number;
  /** Content width of the worktrees pane. */
  rightWidth: number;
  /** Rows available for list content in either pane. */
  bodyRows: number;
  /** Rows the worktree list may use before the detail box starts. */
  listRows: number;
  /** Content rows of the detail box (0 when the terminal is too short). */
  detailRows: number;
  /** Screen column where the worktrees pane content starts. */
  rightColumn: number;
  /** Screen row of the pane header line. */
  headerRow: number;
}

export interface ScreenContext {
  width: number;
  height: number;
  now: number;
  tick: number;
  home: string;
  /** Scroll offsets kept by the caller so the cursor moves like it does in vim. */
  repoScroll: number;
  worktreeScroll: number;
  /** True while a dialog owns the screen: the base view fades to one shade. */
  ghosted: boolean;
}

export function layoutOf(width: number, height: number): ScreenLayout {
  const inner = Math.max(20, width - 2);
  const leftWidth = Math.max(16, Math.min(26, Math.round(inner * 0.24)));
  const rightWidth = Math.max(10, inner - leftWidth - 1);
  const bodyRows = Math.max(1, height - 7);
  const detailRows = bodyRows >= 13 ? 4 : bodyRows >= 8 ? 3 : 0;
  const listRows = detailRows === 0 ? bodyRows : bodyRows - detailRows - 1;
  return {
    width,
    height,
    leftWidth,
    rightWidth,
    bodyRows,
    listRows,
    detailRows,
    rightColumn: 1 + leftWidth + 1,
    headerRow: 3,
  };
}

/**
 * vim-like scrolling: the viewport only moves once the cursor comes within
 * `scrolloff` rows of an edge, so the list stays still while you step through it.
 */
export function nextScroll(
  previous: number,
  cursor: number,
  rows: number,
  total: number,
  scrolloff = 2,
): number {
  if (total <= rows || rows <= 0) return 0;
  const off = Math.min(scrolloff, Math.max(0, Math.floor((rows - 1) / 2)));
  let start = Math.max(0, Math.min(previous, total - rows));
  if (cursor - off < start) start = cursor - off;
  if (cursor + off > start + rows - 1) start = cursor + off - rows + 1;
  return Math.max(0, Math.min(start, total - rows));
}

interface WorktreeColumns {
  branch: number;
  /** Free space parked between the branch and the status cluster. */
  slack: number;
  running: number;
  time: number;
}

/**
 * Branch names hug the left edge; "what is running" and "when" are a cluster
 * pinned to the right edge, so a glance down the right side answers "is anything
 * alive in there?" without reading a single branch name.
 */
export function worktreeColumns(rightWidth: number): WorktreeColumns {
  const time = 7;
  const running = rightWidth >= 72 ? 18 : rightWidth >= 58 ? 14 : rightWidth >= 46 ? 10 : 0;
  // 3 = leading space + state glyph + space; 1 = the right gutter.
  const fixed = 3 + 1 + time + 1 + (running > 0 ? running + 1 : 0);
  const available = Math.max(6, rightWidth - fixed);
  const branch = Math.min(56, available);
  return { branch, slack: available - branch, running, time };
}

function frameCell(text: string): Cell {
  return cell(text, { fg: theme.frame });
}

function operationFor(state: AppState, targetId: string): Operation | undefined {
  return state.operations.find((operation) => operation.targetId === targetId);
}

function sessionOf(state: AppState, worktree: Worktree): SessionState | undefined {
  return state.statuses[worktree.id]?.session;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function topFrame(layout: ScreenLayout): Line {
  const title = " swarm ";
  const fill = Math.max(0, layout.width - 2 - title.length - 1);
  return [
    frameCell(`${box.topLeft}${box.horizontal}`),
    cell(title, { fg: theme.accent, bold: true }),
    frameCell(repeat(box.horizontal, fill)),
    frameCell(box.topRight),
  ];
}

function bottomFrame(layout: ScreenLayout): Line {
  return [
    frameCell(`${box.bottomLeft}${repeat(box.horizontal, layout.width - 2)}${box.bottomRight}`),
  ];
}

function contextTabs(state: AppState): Line {
  if (state.contexts.length === 0) {
    return [
      cell("no contexts", { fg: theme.dim }),
      cell("  N", { fg: theme.accent }),
      cell(" to create one", { fg: theme.dim }),
    ];
  }
  const line: Line = [];
  state.contexts.forEach((context, index) => {
    const active = context.id === state.activeContextId;
    line.push(cell(`${index + 1}`, { fg: active ? theme.accent : theme.dim }));
    line.push(cell(" ", {}));
    line.push(
      cell(context.name, {
        fg: active ? theme.strong : theme.muted,
        bold: active,
        underline: active,
      }),
    );
    line.push(cell("   ", {}));
  });
  return line;
}

function sessionSummary(state: AppState): Line {
  let attached = 0;
  let detached = 0;
  for (const worktree of state.worktrees) {
    const session = state.statuses[worktree.id]?.session;
    if (session === "attached") attached += 1;
    else if (session === "detached") detached += 1;
  }
  if (attached === 0 && detached === 0) {
    return [cell("no live sessions", { fg: theme.dim })];
  }
  const line: Line = [];
  if (attached > 0) {
    line.push(cell(`${glyphs.attached} `, { fg: theme.green }));
    line.push(cell(`${attached} live`, { fg: theme.muted }));
  }
  if (attached > 0 && detached > 0) line.push(cell(` ${glyphs.sep} `, { fg: theme.dim }));
  if (detached > 0) {
    line.push(cell(`${glyphs.detached} `, { fg: theme.yellow }));
    line.push(cell(`${detached} sleeping`, { fg: theme.muted }));
  }
  return line;
}

function headerLine(state: AppState, layout: ScreenLayout): Line {
  const inner = layout.width - 2;
  const content = spread(
    [cell(" ", {}), ...contextTabs(state)],
    [...sessionSummary(state), cell(" ", {})],
    inner,
  );
  return [frameCell(box.vertical), ...content, frameCell(box.vertical)];
}

function rule(layout: ScreenLayout, junction: string): Line {
  return [
    frameCell(
      `${box.teeLeft}${repeat(box.horizontal, layout.leftWidth)}${junction}` +
        `${repeat(box.horizontal, layout.rightWidth)}${box.teeRight}`,
    ),
  ];
}

// ---------------------------------------------------------------------------
// Pane headers
// ---------------------------------------------------------------------------

function paneTitle(text: string, focused: boolean): Cell {
  return cell(text, { fg: focused ? theme.accent : theme.dim, bold: focused });
}

function reposHeader(state: AppState, layout: ScreenLayout): Line {
  const focused = state.pane === "repos";
  const repos = visibleRepoItems(state);
  return spread(
    [cell(" ", {}), paneTitle("REPOS", focused)],
    [cell(`${repos.length}`, { fg: theme.dim }), cell(" ", {})],
    layout.leftWidth,
  );
}

function worktreesHeader(state: AppState, layout: ScreenLayout, scroll: number): Line {
  const focused = state.pane === "worktrees";
  const repo = selectedRepo(state);
  const worktrees = visibleWorktrees(state);
  const hiddenAbove = scroll;
  const hiddenBelow = Math.max(0, worktrees.length - scroll - layout.listRows);

  if (state.mode === "filter") {
    // The live query is painted by a real input renderable laid over this row.
    return spread(
      [cell(" ", {}), cell("/", { fg: theme.accent, bold: true }), cell(" ", {})],
      [
        cell(`${worktrees.length}`, { fg: worktrees.length === 0 ? theme.red : theme.strong }),
        cell(` of ${visibleWorktrees({ ...state, filter: "" }).length}`, { fg: theme.dim }),
        cell(" ", {}),
      ],
      layout.rightWidth,
    );
  }

  const left: Line = [cell(" ", {}), paneTitle("WORKTREES", focused)];
  if (state.filter !== "") {
    left.push(cell(` ${glyphs.sep} `, { fg: theme.dim }));
    left.push(cell(`/${truncate(state.filter, 20)}`, { fg: theme.yellow }));
  } else if (repo) {
    left.push(cell(` ${glyphs.sep} `, { fg: theme.dim }));
    left.push(cell(repo.name, { fg: theme.muted }));
  } else {
    left.push(cell(` ${glyphs.sep} all repos`, { fg: theme.dim }));
  }

  const right: Line = [];
  if (hiddenAbove > 0) right.push(cell(`${glyphs.up}${hiddenAbove} `, { fg: theme.dim }));
  if (hiddenBelow > 0) right.push(cell(`${glyphs.down}${hiddenBelow} `, { fg: theme.dim }));
  right.push(cell(`${worktrees.length}`, { fg: theme.dim }), cell(" ", {}));

  return spread(left, right, layout.rightWidth);
}

// ---------------------------------------------------------------------------
// Repos pane rows
// ---------------------------------------------------------------------------

function repoRow(
  state: AppState,
  layout: ScreenLayout,
  context: ScreenContext,
  index: number,
  item: RepoListItem | undefined,
  ambiguousNames: Set<string>,
): Line {
  const focused = state.pane === "repos";
  const selected = state.repoCursor === index;
  const width = layout.leftWidth;

  const clone = item && isCloneJob(item) ? item : undefined;
  const repo = item && !isCloneJob(item) ? item : undefined;
  const nameWidth = Math.max(4, width - (clone ? 16 : 10));
  const worktrees = clone
    ? []
    : repo
      ? state.worktrees.filter((worktree) => worktree.repoId === repo.id)
      : state.worktrees.filter((worktree) =>
          visibleRepos(state).some((candidate) => candidate.id === worktree.repoId),
        );
  const session = aggregateSession(worktrees.map((worktree) => sessionOf(state, worktree)));
  const glyph = stateGlyph(session);
  const operation = repo ? operationFor(state, repo.id) : undefined;

  const label = item
    ? ambiguousNames.has(item.name)
      ? `${item.owner}/${item.name}`
      : item.name
    : "All";
  const nameFg = selected ? theme.cursorFg : item ? theme.text : theme.muted;

  const line: Line = [
    cell(" ", {}),
    cell(selected ? glyphs.cursor : " ", { fg: theme.accent, bold: true }),
    cell(" ", {}),
  ];

  if (clone) {
    line.push(cell(pad(truncate(label, nameWidth), nameWidth), { fg: nameFg }));
    line.push(cell(" ", {}));
    line.push(
      clone.status === "failed"
        ? cell("! failed", { fg: theme.red, bold: true })
        : cell(`${spinnerFrame(context.tick)} cloning…`, { fg: theme.accent }),
    );
    line.push(cell(" ", {}));
  } else if (operation) {
    line.push(cell(pad(truncate(label, nameWidth), nameWidth), { fg: nameFg, bold: !repo }));
    line.push(cell(" ", {}));
    line.push(cell(padStart(spinnerFrame(context.tick), 3), { fg: theme.accent }));
    line.push(cell("  ", {}));
  } else {
    line.push(cell(pad(truncate(label, nameWidth), nameWidth), { fg: nameFg, bold: !repo }));
    line.push(cell(" ", {}));
    line.push(
      cell(padStart(`${worktrees.length}`, 3), { fg: selected ? theme.strong : theme.dim }),
    );
    line.push(cell(" ", {}));
    line.push(cell(session === "none" ? " " : glyph.char, { fg: glyph.fg }), cell(" ", {}));
  }

  const fitted = fitLine(line, width);
  if (!selected) return fitted;
  return withBackground(fitted, focused ? theme.cursorBg : theme.cursorBgBlur);
}

function reposPaneRows(state: AppState, layout: ScreenLayout, context: ScreenContext): Line[] {
  const repos = visibleRepoItems(state);
  const rows: Line[] = [];
  const seen = new Map<string, number>();
  for (const repo of repos) seen.set(repo.name, (seen.get(repo.name) ?? 0) + 1);
  const ambiguous = new Set(
    [...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name),
  );

  if (state.contexts.length === 0) {
    rows.push(emptyRow(layout.leftWidth, "—"));
    return rows;
  }

  const entries: Array<RepoListItem | undefined> = [undefined, ...repos];
  const visible = entries.slice(context.repoScroll, context.repoScroll + layout.bodyRows);
  visible.forEach((repo, offset) => {
    rows.push(repoRow(state, layout, context, context.repoScroll + offset, repo, ambiguous));
  });

  if (repos.length === 0) {
    rows.push(emptyRow(layout.leftWidth, ""));
    rows.push(hintRow(layout.leftWidth, "n", "clone a repo"));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Worktrees pane rows
// ---------------------------------------------------------------------------

function emptyRow(width: number, text: string): Line {
  return fitLine([cell(`  ${text}`, { fg: theme.dim })], width);
}

function hintRow(width: number, key: string, label: string): Line {
  return fitLine(
    [
      cell("  ", {}),
      cell(key, { fg: theme.accent, bold: true }),
      cell(` ${label}`, { fg: theme.dim }),
    ],
    width,
  );
}

function worktreeRow(
  state: AppState,
  layout: ScreenLayout,
  context: ScreenContext,
  worktree: Worktree,
  index: number,
  positions: readonly number[],
  showRepo: boolean,
): Line {
  const focused = state.pane === "worktrees";
  const selected = state.worktreeCursor === index;
  const columns = worktreeColumns(layout.rightWidth);
  const status = state.statuses[worktree.id];
  const glyph = stateGlyph(status?.session);
  const operation = operationFor(state, worktree.id);
  const repo = state.repos.find((candidate) => candidate.id === worktree.repoId);

  const line: Line = [
    cell(" ", {}),
    operation
      ? cell(spinnerFrame(context.tick), { fg: theme.accent, bold: true })
      : cell(glyph.char, { fg: glyph.fg }),
    cell(" ", {}),
  ];

  const prefix = showRepo && repo ? `${repo.name} ${glyphs.sep} ` : "";
  const branchStyle = {
    fg: selected ? theme.cursorFg : theme.text,
    bold: selected,
  };
  const branchText = truncate(`${prefix}${worktree.branch}`, columns.branch);
  const written = branchText.length;
  if (prefix !== "" && branchText.startsWith(prefix)) {
    line.push(cell(prefix, { fg: selected ? theme.muted : theme.dim }));
    line.push(
      ...highlight(branchText.slice(prefix.length), positions, branchStyle, {
        fg: theme.yellow,
        bold: true,
      }),
    );
  } else {
    line.push(...highlight(branchText, positions, branchStyle, { fg: theme.yellow, bold: true }));
  }
  line.push(cell(repeat(" ", Math.max(0, columns.branch - written)), {}));

  if (operation) {
    line.push(cell(" ", {}));
    line.push(
      cell(`${operation.step}`, {
        fg: theme.accent,
      }),
    );
  } else {
    line.push(cell(repeat(" ", columns.slack), {}));
    if (columns.running > 0) {
      line.push(cell(" ", {}));
      const running = runningLabel(status);
      line.push(
        cell(padStart(truncate(running === "" ? "–" : running, columns.running), columns.running), {
          fg: running === "" ? theme.ghost : theme.yellow,
        }),
      );
    }
    line.push(cell(" ", {}));
    const opened = worktree.lastOpenedAt;
    line.push(
      cell(padStart(relativeTime(opened ?? worktree.createdAt, context.now), columns.time), {
        fg: opened ? theme.dim : theme.ghost,
      }),
    );
  }

  const fitted = fitLine(line, layout.rightWidth);
  if (!selected) return fitted;
  return withBackground(fitted, focused ? theme.cursorBg : theme.cursorBgBlur);
}

function worktreesPaneRows(state: AppState, layout: ScreenLayout, context: ScreenContext): Line[] {
  const worktrees = visibleWorktrees(state);
  const repo = selectedRepo(state);
  const rows: Line[] = [];

  if (worktrees.length === 0) {
    rows.push(emptyRow(layout.rightWidth, ""));
    if (state.contexts.length === 0) {
      rows.push(emptyRow(layout.rightWidth, "No contexts yet."));
      rows.push(hintRow(layout.rightWidth, "N", "create your first context"));
    } else if (state.filter !== "") {
      rows.push(emptyRow(layout.rightWidth, `Nothing matches “${truncate(state.filter, 24)}”.`));
      rows.push(
        hintRow(
          layout.rightWidth,
          "Esc",
          state.mode === "filter" ? "leave input; press Esc again to clear" : "clear the filter",
        ),
      );
    } else if (visibleRepos(state).length === 0) {
      const active = state.contexts.find((item) => item.id === state.activeContextId);
      rows.push(emptyRow(layout.rightWidth, `No repos in ${active?.name ?? "this context"}.`));
      rows.push(hintRow(layout.rightWidth, "n", "clone one"));
    } else {
      rows.push(emptyRow(layout.rightWidth, `No worktrees${repo ? ` for ${repo.name}` : ""} yet.`));
      rows.push(hintRow(layout.rightWidth, "n", "create one"));
    }
    return rows;
  }

  const showRepo = repo === undefined || state.filter !== "";
  const matches = new Map<string, number[]>();
  if (state.filter !== "") {
    for (const match of fuzzyFilter(state.filter, worktrees, (worktree) => worktree.branch)) {
      matches.set(match.item.id, match.positions);
    }
  }

  const visible = worktrees.slice(context.worktreeScroll, context.worktreeScroll + layout.listRows);
  visible.forEach((worktree, offset) => {
    rows.push(
      worktreeRow(
        state,
        layout,
        context,
        worktree,
        context.worktreeScroll + offset,
        matches.get(worktree.id) ?? [],
        showRepo,
      ),
    );
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Detail box
// ---------------------------------------------------------------------------

function detailLines(state: AppState, layout: ScreenLayout, context: ScreenContext): Line[] {
  const width = layout.rightWidth;
  const lines: Line[] = [];
  const worktree = selectedWorktree(state);
  const repo = selectedRepo(state);
  const clone = selectedClone(state);

  if (state.pane === "repos" && clone) {
    lines.push([
      cell(" ", {}),
      cell(clone.name, { fg: theme.strong, bold: true }),
      cell(` ${glyphs.sep} `, { fg: theme.dim }),
      cell(clone.status === "failed" ? "clone failed" : "cloning…", {
        fg: clone.status === "failed" ? theme.red : theme.accent,
      }),
    ]);
    lines.push([
      cell(" ", {}),
      cell(truncateStart(tildePath(clone.path, context.home), width - 2), { fg: theme.dim }),
    ]);
    lines.push([
      cell(" ", {}),
      cell(`log ${truncateStart(tildePath(clone.logPath, context.home), width - 6)}`, {
        fg: theme.ghost,
      }),
    ]);
    if (clone.error)
      lines.push([cell(" ", {}), cell(truncate(clone.error, width - 2), { fg: theme.red })]);
    return lines.slice(0, layout.detailRows).map((line) => fitLine(line, width));
  }

  if (state.pane === "repos" && repo) {
    const repoWorktrees = state.worktrees.filter((item) => item.repoId === repo.id);
    const live = repoWorktrees.filter(
      (item) => sessionOf(state, item) !== undefined && sessionOf(state, item) !== "none",
    );
    lines.push([
      cell(" ", {}),
      cell(repo.name, { fg: theme.strong, bold: true }),
      cell(` ${glyphs.sep} `, { fg: theme.dim }),
      cell(repo.owner, { fg: theme.muted }),
      cell(` ${glyphs.sep} default `, { fg: theme.dim }),
      cell(repo.defaultBranch, { fg: theme.cyan }),
    ]);
    lines.push([
      cell(" ", {}),
      cell(truncateStart(tildePath(repo.path, context.home), width - 2), { fg: theme.dim }),
    ]);
    lines.push([
      cell(" ", {}),
      cell(`${repoWorktrees.length}`, { fg: theme.text }),
      cell(" worktrees", { fg: theme.dim }),
      cell(` ${glyphs.sep} `, { fg: theme.dim }),
      cell(`${live.length}`, { fg: live.length > 0 ? theme.green : theme.text }),
      cell(" live", { fg: theme.dim }),
      cell(` ${glyphs.sep} hooks `, { fg: theme.dim }),
      cell(repo.hooks.postCreate.join(" && ") || "none", { fg: theme.muted }),
    ]);
    lines.push([cell(" ", {}), cell(truncate(repo.url, width - 2), { fg: theme.ghost })]);
    return lines.slice(0, layout.detailRows).map((line) => fitLine(line, width));
  }

  if (state.pane === "repos" && !repo) {
    const active = state.contexts.find((item) => item.id === state.activeContextId);
    const repos = visibleRepos(state);
    const worktrees = visibleWorktrees(state);
    lines.push([
      cell(" ", {}),
      cell(active?.name ?? "No context", { fg: theme.strong, bold: true }),
      cell(` ${glyphs.sep} owners `, { fg: theme.dim }),
      cell(active?.owners.join(", ") || "none", { fg: theme.muted }),
    ]);
    lines.push([
      cell(" ", {}),
      cell(`${repos.length}`, { fg: theme.text }),
      cell(" repos", { fg: theme.dim }),
      cell(` ${glyphs.sep} `, { fg: theme.dim }),
      cell(`${worktrees.length}`, { fg: theme.text }),
      cell(" worktrees", { fg: theme.dim }),
    ]);
    lines.push([
      cell(" ", {}),
      cell("Enter", { fg: theme.accent, bold: true }),
      cell(" to browse every worktree", { fg: theme.dim }),
    ]);
    lines.push([]);
    return lines.slice(0, layout.detailRows).map((line) => fitLine(line, width));
  }

  if (!worktree) {
    const hint: Line[] = [
      [],
      [cell(" ", {}), cell("nothing selected", { fg: theme.ghost })],
      [],
      [],
    ];
    return hint.slice(0, layout.detailRows).map((line) => fitLine(line, width));
  }

  const status = state.statuses[worktree.id];
  const repoOfWorktree = state.repos.find((item) => item.id === worktree.repoId);
  lines.push([
    cell(" ", {}),
    cell(worktree.branch, { fg: theme.strong, bold: true }),
    cell(` ${glyphs.sep} `, { fg: theme.dim }),
    cell(repoOfWorktree?.id ?? worktree.repoId, { fg: theme.muted }),
    cell(` ${glyphs.sep} base `, { fg: theme.dim }),
    cell(worktree.baseRef, { fg: theme.cyan }),
  ]);
  lines.push([
    cell(" ", {}),
    cell(truncateStart(tildePath(worktree.path, context.home), width - 2), { fg: theme.dim }),
  ]);

  const windowLine: Line = [cell(" windows  ", { fg: theme.dim })];
  if (!status || status.windows.length === 0) {
    windowLine.push(
      cell(status?.session === "none" || !status ? "no session" : "none", { fg: theme.ghost }),
    );
  } else {
    status.windows.forEach((window, index) => {
      if (index > 0) windowLine.push(cell(` ${glyphs.sep} `, { fg: theme.dim }));
      windowLine.push(cell(window.name, { fg: theme.text }));
      if (window.keepAlive.length > 0) {
        windowLine.push(cell(` ${window.keepAlive.join(" ")}`, { fg: theme.yellow }));
      }
    });
  }
  lines.push(windowLine);

  lines.push([
    cell(" ", {}),
    cell("session ", { fg: theme.dim }),
    cell(worktree.session, { fg: theme.muted }),
    cell(` ${glyphs.sep} created `, { fg: theme.dim }),
    cell(relativeTime(worktree.createdAt, context.now), { fg: theme.muted }),
    cell(` ${glyphs.sep} opened `, { fg: theme.dim }),
    cell(relativeTime(worktree.lastOpenedAt, context.now), { fg: theme.muted }),
  ]);

  return lines.slice(0, layout.detailRows).map((line) => fitLine(line, width));
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function footerContent(state: AppState, layout: ScreenLayout, context: ScreenContext): Line {
  const width = layout.width - 2;
  const operation = state.operations[state.operations.length - 1];
  if (operation) {
    const line: Line = [
      cell(" ", {}),
      cell(spinnerFrame(context.tick), { fg: theme.accent, bold: true }),
      cell(" ", {}),
      cell(operation.label, { fg: theme.strong }),
      cell(` ${glyphs.sep} `, { fg: theme.dim }),
      cell(operation.step, { fg: theme.accent }),
    ];
    const last = operation.log[operation.log.length - 1];
    if (last) line.push(cell(`  ${last}`, { fg: theme.dim }));
    return fitLine(line, width);
  }

  const toast = state.toasts[state.toasts.length - 1];
  if (toast) {
    const fg =
      toast.level === "error" ? theme.red : toast.level === "success" ? theme.green : theme.cyan;
    const marker =
      toast.level === "error" ? "!" : toast.level === "success" ? glyphs.check : glyphs.sep;
    return fitLine(
      [cell(" ", {}), cell(marker, { fg, bold: true }), cell(` ${toast.text}`, { fg })],
      width,
    );
  }

  if (state.error) {
    return fitLine(
      [
        cell(" ", {}),
        cell("!", { fg: theme.red, bold: true }),
        cell(` ${state.error}`, { fg: theme.red }),
      ],
      width,
    );
  }

  if (state.mode === "filter") {
    const line: Line = [cell(" ", {})];
    for (const [key, label] of [
      ["type", "to filter"],
      ["⏎", "open selected match"],
      ["Esc", "keep filter"],
    ] as const) {
      line.push(cell(key, { fg: theme.accent, bold: true }));
      line.push(cell(` ${label}`, { fg: theme.dim }));
      line.push(cell("   ", {}));
    }
    return fitLine(line, width);
  }

  const hints = KEY_HINTS[state.pane];
  // `?` closes the list of hints unless the keymap already spells it out.
  const withHelp = hints.some((hint) => hint.key === "?")
    ? hints
    : [...hints, { key: "?", label: "help" }];
  const line: Line = [cell(" ", {})];
  withHelp.forEach((hint, index) => {
    if (index > 0) line.push(cell("  ", {}));
    line.push(cell(hint.key, { fg: theme.accent, bold: true }));
    line.push(cell(` ${hint.label}`, { fg: theme.dim }));
  });
  return fitLine(line, width);
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Build the whole base screen as an array of exactly `height` lines, each
 * exactly `width` cells wide.
 */
export function buildScreen(state: AppState, context: ScreenContext): Line[] {
  const layout = layoutOf(context.width, context.height);
  const lines: Line[] = [topFrame(layout), headerLine(state, layout), rule(layout, box.teeDown)];

  const paneHeaders: Line = [
    frameCell(box.vertical),
    ...reposHeader(state, layout),
    frameCell(box.vertical),
    ...worktreesHeader(state, layout, context.worktreeScroll),
    frameCell(box.vertical),
  ];
  lines.push(paneHeaders);

  const leftRows = reposPaneRows(state, layout, context);
  const rightRows = worktreesPaneRows(state, layout, context);
  const details = layout.detailRows > 0 ? detailLines(state, layout, context) : [];

  const blankLeft = fitLine([], layout.leftWidth);
  const blankRight = fitLine([], layout.rightWidth);

  for (let row = 0; row < layout.bodyRows; row += 1) {
    const left = leftRows[row] ?? blankLeft;
    const isDetailRule = layout.detailRows > 0 && row === layout.listRows;
    if (isDetailRule) {
      lines.push([
        frameCell(box.vertical),
        ...left,
        frameCell(box.teeLeft),
        frameCell(repeat(box.horizontal, layout.rightWidth)),
        frameCell(box.teeRight),
      ]);
      continue;
    }
    const right =
      layout.detailRows > 0 && row > layout.listRows
        ? (details[row - layout.listRows - 1] ?? blankRight)
        : (rightRows[row] ?? blankRight);
    lines.push([
      frameCell(box.vertical),
      ...left,
      frameCell(box.vertical),
      ...right,
      frameCell(box.vertical),
    ]);
  }

  lines.push(rule(layout, box.teeUp));
  lines.push([
    frameCell(box.vertical),
    ...footerContent(state, layout, context),
    frameCell(box.vertical),
  ]);
  lines.push(bottomFrame(layout));

  const trimmed = lines.slice(0, context.height);
  return context.ghosted ? trimmed.map(ghostLine) : trimmed;
}
