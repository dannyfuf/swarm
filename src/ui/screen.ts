import { KEY_HINTS } from "../app/keymap.ts";
import {
  isCloneJob,
  prErrorsInScope,
  prHints,
  prLoadingInScope,
  prScopeRepoIds,
  prsInScope,
  prWorktree,
  type RepoListItem,
  reviewCount,
  selectedClone,
  selectedPr,
  selectedRepo,
  selectedWorktree,
  visibleRepoItems,
  visibleRepos,
  visibleWorktrees,
  worktreePr,
} from "../app/selectors.ts";
import type { AppState, Operation } from "../core/app.ts";
import { fuzzyFilter } from "../core/fuzzy.ts";
import { slugify, worktreeId } from "../core/paths.ts";
import { prLocalBranch, prState, prStateLabel } from "../core/prs.ts";
import {
  type PrState,
  type PrTab,
  type PullRequest,
  type SessionState,
  type Worktree,
  worktreeHost,
} from "../core/types.ts";
import {
  aggregateSession,
  relativeTime,
  runningLabel,
  sessionLabel,
  stateGlyph,
  tildePath,
} from "./format.ts";
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
  prScroll: number;
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
  /** Width of the `#1234 approved` PR badge; 0 when no row has a PR. */
  badge: number;
  time: number;
}

/** `#12345 approved` — the widest badge a worktree row can carry. */
const PR_BADGE_WIDTH = 15;

/**
 * Branch names hug the left edge; "what is running" and "when" are a cluster
 * pinned to the right edge, so a glance down the right side answers "is anything
 * alive in there?" without reading a single branch name. The PR badge joins that
 * cluster only when some visible row actually has a pull request, so the column
 * never taxes branch names it would leave blank.
 */
export function worktreeColumns(rightWidth: number, badged = false): WorktreeColumns {
  const time = 7;
  const running = rightWidth >= 72 ? 18 : rightWidth >= 58 ? 14 : rightWidth >= 46 ? 10 : 0;
  const badge = badged && running > 0 ? PR_BADGE_WIDTH : 0;
  // 3 = leading space + state glyph + space; 1 = the right gutter.
  const fixed = 3 + 1 + time + 1 + (running > 0 ? running + 1 : 0) + (badge > 0 ? badge + 1 : 0);
  const available = Math.max(6, rightWidth - fixed);
  const branch = Math.min(56, available);
  return { branch, slack: available - branch, running, badge, time };
}

/**
 * The six PR states in priority order, each with the one colour that makes the
 * column readable as a vertical scan: red means "you have work", green "done".
 */
function prStateStyle(state: PrState): string {
  switch (state) {
    case "draft":
      return theme.dim;
    case "ci_fail":
    case "changes":
      return theme.red;
    case "ci_pending":
      return theme.yellow;
    case "approved":
      return theme.green;
    case "review":
      return theme.muted;
  }
}

/** `#1234 approved`, right aligned into `width` cells. */
function prBadge(pr: PullRequest, width: number, dimmed: boolean): Line {
  const label = prStateLabel(prState(pr));
  const number = truncate(`#${pr.number}`, Math.max(1, width - label.length - 1));
  const text = `${number} ${label}`;
  return [
    cell(repeat(" ", Math.max(0, width - text.length)), {}),
    cell(`${number} `, { fg: dimmed ? theme.muted : theme.dim }),
    cell(label, { fg: prStateStyle(prState(pr)) }),
  ];
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
  let unknown = 0;
  for (const worktree of state.worktrees) {
    const session = state.statuses[worktree.id]?.session;
    if (session === "attached") attached += 1;
    else if (session === "detached") detached += 1;
    else if (session === "unknown") unknown += 1;
  }
  const line: Line = [];
  if (attached === 0 && detached === 0 && unknown === 0) {
    line.push(cell("no live sessions", { fg: theme.dim }));
  } else {
    if (attached > 0) {
      line.push(cell(`${glyphs.attached} `, { fg: theme.green }));
      line.push(cell(`${attached} live`, { fg: theme.muted }));
    }
    if (attached > 0 && detached > 0) line.push(cell(` ${glyphs.sep} `, { fg: theme.dim }));
    if (detached > 0) {
      line.push(cell(`${glyphs.detached} `, { fg: theme.yellow }));
      line.push(cell(`${detached} sleeping`, { fg: theme.muted }));
    }
    if (unknown > 0) {
      if (attached > 0 || detached > 0) line.push(cell(` ${glyphs.sep} `, { fg: theme.dim }));
      line.push(cell(`? ${unknown} offline`, { fg: theme.dim }));
    }
  }

  // The one number worth interrupting the session summary for: work waiting on you.
  const reviews = reviewCount(state);
  if (reviews > 0) {
    line.push(cell(` ${glyphs.sep} `, { fg: theme.dim }));
    line.push(cell(`${reviews}`, { fg: theme.yellow }));
    line.push(cell(" to review", { fg: theme.muted }));
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
  showBadge: boolean,
): Line {
  const focused = state.pane === "worktrees";
  const selected = state.worktreeCursor === index;
  const columns = worktreeColumns(layout.rightWidth, showBadge);
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
  const hostId = worktreeHost(worktree);
  const remote = hostId !== "local";
  const fullHostBadge = `@${hostId}`;
  const hostBadge = remote
    ? truncate(fullHostBadge, Math.max(1, Math.min(fullHostBadge.length, columns.branch - 2)))
    : "";
  const badgeGap = hostBadge === "" ? 0 : 1;
  const branchWidth = Math.max(1, columns.branch - hostBadge.length - badgeGap);
  const branchText = truncate(`${prefix}${worktree.branch}`, branchWidth);
  const written = branchText.length + badgeGap + hostBadge.length;
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
  if (hostBadge !== "") {
    line.push(cell(" ", {}));
    line.push(cell(hostBadge, { fg: selected ? theme.accent : theme.muted, bold: selected }));
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
    if (columns.badge > 0) {
      line.push(cell(" ", {}));
      const pr = worktreePr(state, worktree);
      if (pr) line.push(...prBadge(pr, columns.badge, selected));
      else line.push(cell(repeat(" ", columns.badge), {}));
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
  const showBadge = visible.some((worktree) => worktreePr(state, worktree) !== undefined);
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
        showBadge,
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
    const live = repoWorktrees.filter((item) => {
      const session = sessionOf(state, item);
      return session === "attached" || session === "detached";
    });
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
      cell(` ${glyphs.sep} prepare `, { fg: theme.dim }),
      cell(repo.hooks.prepare.join(" && ") || "none", { fg: theme.muted }),
      cell(` ${glyphs.sep} post `, { fg: theme.dim }),
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
  const hostId = worktreeHost(worktree);
  const remote = hostId !== "local";
  const branchLine: Line = [
    cell(" ", {}),
    cell(worktree.branch, { fg: theme.strong, bold: true }),
    ...(remote
      ? [cell(` ${glyphs.sep} host: `, { fg: theme.dim }), cell(hostId, { fg: theme.muted })]
      : []),
    cell(` ${glyphs.sep} `, { fg: theme.dim }),
    cell(repoOfWorktree?.id ?? worktree.repoId, { fg: theme.muted }),
    cell(` ${glyphs.sep} base `, { fg: theme.dim }),
    cell(worktree.baseRef, { fg: theme.cyan }),
  ];
  const linkedPr = worktreePr(state, worktree);
  if (linkedPr) {
    branchLine.push(cell(` ${glyphs.sep} PR `, { fg: theme.dim }));
    branchLine.push(cell(`#${linkedPr.number} `, { fg: theme.muted }));
    branchLine.push(cell(prStateLabel(prState(linkedPr)), { fg: prStateStyle(prState(linkedPr)) }));
  }
  lines.push(branchLine);
  if (remote) {
    lines.push([
      cell(" ", {}),
      cell(`${hostId}:`, { fg: theme.muted }),
      cell(truncateStart(worktree.path, width - hostId.length - 3), { fg: theme.dim }),
    ]);
  } else {
    lines.push([
      cell(" ", {}),
      cell(truncateStart(tildePath(worktree.path, context.home), width - 2), { fg: theme.dim }),
    ]);
  }

  const windowLine: Line = [cell(" windows  ", { fg: theme.dim })];
  if (!status || status.windows.length === 0) {
    windowLine.push(
      cell(
        status?.session === "unknown"
          ? "offline"
          : status?.session === "none" || !status
            ? "no session"
            : "none",
        { fg: theme.ghost },
      ),
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
  const remoteError = remote ? state.remoteErrors[hostId] : undefined;
  lines.push(
    remoteError
      ? [cell(" ", {}), cell(truncate(`offline: ${remoteError}`, width - 2), { fg: theme.dim })]
      : windowLine,
  );

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

export interface Hint {
  key: string;
  label: string;
}

/**
 * Cells a hint row occupies once rendered: a leading space, then `key label`
 * pairs separated by two spaces. Kept next to the renderer below so the two
 * cannot drift apart.
 */
export function hintsWidth(hints: readonly Hint[]): number {
  return hints.reduce(
    (total, hint, index) => total + (index > 0 ? 2 : 0) + hint.key.length + 1 + hint.label.length,
    1,
  );
}

/**
 * Shed hints, least essential first, until the row fits `width`. Keys missing
 * from `dropOrder` are load-bearing and survive even when the row still
 * overflows — a clipped `Esc back` is worse than a clipped optional hint.
 */
export function fitHints(
  hints: readonly Hint[],
  width: number,
  dropOrder: readonly string[],
): Hint[] {
  let kept = [...hints];
  for (const key of dropOrder) {
    if (hintsWidth(kept) <= width) break;
    kept = kept.filter((hint) => hint.key !== key);
  }
  return kept;
}

/** Least to most essential; `Enter`, `Esc` and `?` are never dropped. */
const PR_HINT_DROP_ORDER = ["O", "b", "y", "/", "r", "U", "Tab"] as const;

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

  if (state.loading) {
    return fitLine(
      [
        cell(" ", {}),
        cell(spinnerFrame(context.tick), { fg: theme.accent, bold: true }),
        cell(" Loading workspace…", { fg: theme.dim }),
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

  // On the PR screen the hints are computed by the app layer because the primary
  // action changes with the selected row ("open" vs "create worktree").
  const hints = state.screen === "prs" ? prHints(state) : KEY_HINTS[state.pane];
  // `?` closes the list of hints unless the keymap already spells it out.
  const withHelp = hints.some((hint) => hint.key === "?")
    ? hints
    : [...hints, { key: "?", label: "help" }];
  // The PR footer is the longest row in the app; rather than let it clip at an
  // arbitrary character, shed the least essential hints until it fits.
  const fitted = state.screen === "prs" ? fitHints(withHelp, width, PR_HINT_DROP_ORDER) : withHelp;
  const line: Line = [cell(" ", {})];
  fitted.forEach((hint, index) => {
    if (index > 0) line.push(cell("  ", {}));
    line.push(cell(hint.key, { fg: theme.accent, bold: true }));
    line.push(cell(` ${hint.label}`, { fg: theme.dim }));
  });
  return fitLine(line, width);
}

// ---------------------------------------------------------------------------
// Pull requests screen
// ---------------------------------------------------------------------------

export interface PrColumns {
  /** `#1234` — identity. */
  number: number;
  title: number;
  /** Review tab only; 0 once the row gets too narrow to afford it. */
  author: number;
  /** 0 once the row gets too narrow: the state word matters more than "where". */
  branch: number;
  state: number;
  time: number;
  /** Whether the branch column carries a `<repo> ·` prefix. */
  showRepo: boolean;
}

/** Leading space + cursor + space + presence glyph + space. */
const PR_LEAD = 5;

/**
 * The PR row answers, left to right: is it here already, which PR, what is it,
 * who wrote it, where does it live, what is blocking it, how fresh is it. The
 * last four are a right-pinned cluster, so the columns shed from the middle out
 * as the terminal narrows and the row never wraps.
 */
export function prColumns(width: number, options: { author: boolean; repo: boolean }): PrColumns {
  const time = 7;
  const state = 8;
  const number = 6;
  // 12 fits a first name; from 130 cells on there is room for the 16 a full
  // github login usually needs ("maria-gonzalez", "catalina.rojas").
  const author = options.author && width >= 70 ? (width >= 130 ? 16 : 12) : 0;
  const branch = width >= 90 ? Math.min(34, Math.round(width * 0.24)) : 0;
  const showRepo = branch > 0 && options.repo && width >= 110;
  const fixed =
    PR_LEAD +
    number +
    2 +
    (author > 0 ? author + 2 : 0) +
    (branch > 0 ? branch + 2 : 0) +
    2 +
    state +
    1 +
    time +
    1;
  return { number, title: Math.max(10, width - fixed), author, branch, state, time, showRepo };
}

function prScopeLabel(state: AppState): string {
  const scope = state.prScope;
  if (scope.kind === "repo") {
    return state.repos.find((item) => item.id === scope.repoId)?.name ?? scope.repoId;
  }
  const active = state.contexts.find((item) => item.id === state.activeContextId);
  return `all repos in ${active?.name ?? "this context"}`;
}

/** Newest successful fetch across the repos in scope, for the freshness label. */
function prFetchedAt(state: AppState, tab: PrTab): string | undefined {
  let newest: string | undefined;
  for (const repoId of prScopeRepoIds(state)) {
    const fetchedAt = state.prs[tab][repoId]?.fetchedAt;
    if (fetchedAt && (newest === undefined || fetchedAt > newest)) newest = fetchedAt;
  }
  return newest;
}

function prTabLabel(tab: PrTab): string {
  return tab === "mine" ? "MINE" : "REVIEW";
}

function prsHeader(state: AppState, layout: ScreenLayout, context: ScreenContext): Line {
  const inner = layout.width - 2;
  const total = prsInScope({ ...state, prFilter: "" }, state.prTab).length;

  if (state.mode === "filter") {
    // The live query is painted by a real input renderable laid over this row.
    const matches = prsInScope(state, state.prTab).length;
    return spread(
      [cell(" ", {}), cell("/", { fg: theme.accent, bold: true }), cell(" ", {})],
      [
        cell(`${matches}`, { fg: matches === 0 ? theme.red : theme.strong }),
        cell(` of ${total}`, { fg: theme.dim }),
        cell(" ", {}),
      ],
      inner,
    );
  }

  // Narrow terminals shed the anchoring label, then the scope, before the tabs
  // and the freshness — the two things that change while you watch the screen.
  const left: Line = [cell(" ", {})];
  if (inner >= 84) left.push(cell("PULL REQUESTS", { fg: theme.dim }));
  for (const tab of ["mine", "review"] as const) {
    const active = state.prTab === tab;
    const loading = prLoadingInScope(state, tab);
    left.push(cell("   ", {}));
    left.push(
      cell(prTabLabel(tab), {
        fg: active ? theme.strong : theme.muted,
        bold: active,
        underline: active,
      }),
    );
    left.push(cell(" ", {}));
    left.push(
      loading
        ? cell(spinnerFrame(context.tick), { fg: theme.accent })
        : cell(`${prsInScope({ ...state, prFilter: "" }, tab).length}`, { fg: theme.dim }),
    );
  }
  if (state.prFilter !== "") {
    left.push(cell(`   ${glyphs.sep} `, { fg: theme.dim }));
    left.push(cell(`/${truncate(state.prFilter, 20)}`, { fg: theme.yellow }));
  }

  const fetchedAt = prFetchedAt(state, state.prTab);
  const freshness = prLoadingInScope(state, state.prTab)
    ? "updating…"
    : fetchedAt
      ? `updated ${relativeTime(fetchedAt, context.now)}`
      : "never";
  const right: Line = [];
  if (inner >= 96) {
    right.push(cell(prScopeLabel(state), { fg: theme.muted }));
    right.push(cell(` ${glyphs.sep} `, { fg: theme.dim }));
  }
  right.push(cell(freshness, { fg: theme.dim }), cell(" ", {}));
  return spread(left, right, inner);
}

function prRow(
  state: AppState,
  context: ScreenContext,
  width: number,
  columns: PrColumns,
  pr: PullRequest,
  index: number,
  matches: { title: readonly number[]; branch: readonly number[] },
): Line {
  const selected = state.prCursor === index;
  const worktree = prWorktree(state, pr);
  const glyph = worktree ? stateGlyph(state.statuses[worktree.id]?.session) : undefined;
  const operation = operationFor(state, worktreeId(pr.repoId, slugify(prLocalBranch(pr))));
  const repo = state.repos.find((item) => item.id === pr.repoId);
  const matchStyle = { fg: theme.yellow, bold: true };

  const line: Line = [
    cell(" ", {}),
    cell(selected ? glyphs.cursor : " ", { fg: theme.accent, bold: true }),
    cell(" ", {}),
    operation
      ? cell(spinnerFrame(context.tick), { fg: theme.accent, bold: true })
      : cell(glyph ? glyph.char : " ", { fg: glyph?.fg ?? theme.dim }),
    cell(" ", {}),
    cell(pad(`#${pr.number}`, columns.number), { fg: selected ? theme.muted : theme.dim }),
    cell("  ", {}),
  ];

  const titleText = truncate(pr.title, columns.title);
  line.push(
    ...highlight(
      titleText,
      matches.title,
      { fg: selected ? theme.cursorFg : theme.text, bold: selected },
      matchStyle,
    ),
  );
  line.push(cell(repeat(" ", Math.max(0, columns.title - titleText.length)), {}));

  if (columns.author > 0) {
    line.push(cell("  ", {}));
    line.push(cell(pad(pr.author, columns.author), { fg: theme.muted }));
  }

  if (operation) {
    line.push(cell("  ", {}));
    line.push(cell(operation.step, { fg: theme.accent }));
    return fitLine(line, width);
  }

  if (columns.branch > 0) {
    line.push(cell("  ", {}));
    const prefix = columns.showRepo && repo ? `${repo.name} ${glyphs.sep} ` : "";
    const branchText = truncate(`${prefix}${pr.headRefName}`, columns.branch);
    line.push(cell(repeat(" ", Math.max(0, columns.branch - branchText.length)), {}));
    if (prefix !== "" && branchText.startsWith(prefix)) {
      line.push(cell(prefix, { fg: theme.dim }));
      line.push(
        ...highlight(
          branchText.slice(prefix.length),
          matches.branch,
          { fg: theme.muted },
          matchStyle,
        ),
      );
    } else {
      line.push(...highlight(branchText, matches.branch, { fg: theme.muted }, matchStyle));
    }
  }

  line.push(cell("  ", {}));
  line.push(cell(pad(prStateLabel(prState(pr)), columns.state), { fg: prStateStyle(prState(pr)) }));
  line.push(cell(" ", {}));
  line.push(
    cell(padStart(relativeTime(pr.updatedAt, context.now), columns.time), { fg: theme.dim }),
  );

  const fitted = fitLine(line, width);
  if (!selected) return fitted;
  return withBackground(fitted, theme.cursorBg);
}

function prBodyRows(state: AppState, layout: ScreenLayout, context: ScreenContext): Line[] {
  const width = layout.width - 2;
  const prs = prsInScope(state, state.prTab);
  const errors = prErrorsInScope(state, state.prTab);
  const rows: Line[] = [];

  if (prs.length === 0) {
    if (prLoadingInScope(state, state.prTab)) {
      rows.push(emptyRow(width, ""));
      rows.push(
        fitLine(
          [
            cell("  ", {}),
            cell(spinnerFrame(context.tick), { fg: theme.accent }),
            cell(" loading pull requests…", { fg: theme.dim }),
          ],
          width,
        ),
      );
    } else if (state.prFilter !== "") {
      rows.push(emptyRow(width, ""));
      rows.push(emptyRow(width, `Nothing matches “${truncate(state.prFilter, 24)}”.`));
      rows.push(
        hintRow(
          width,
          "Esc",
          state.mode === "filter" ? "leave input; press Esc again to clear" : "clear the filter",
        ),
      );
    } else {
      const scope = prScopeLabel(state);
      rows.push(emptyRow(width, ""));
      rows.push(
        emptyRow(
          width,
          state.prTab === "mine"
            ? `No open PRs authored by you in ${scope}.`
            : `No PRs waiting for your review in ${scope}.`,
        ),
      );
      rows.push(
        fitLine(
          [
            cell("  ", {}),
            cell("r", { fg: theme.accent, bold: true }),
            cell(" refresh", { fg: theme.dim }),
            cell(` ${glyphs.sep} `, { fg: theme.dim }),
            cell("Tab", { fg: theme.accent, bold: true }),
            cell(` ${prTabLabel(state.prTab === "mine" ? "review" : "mine")}`, { fg: theme.dim }),
          ],
          width,
        ),
      );
    }
  } else {
    const columns = prColumns(width, {
      author: state.prTab === "review",
      repo: state.prScope.kind === "all",
    });
    const titleMatches = new Map<string, number[]>();
    const branchMatches = new Map<string, number[]>();
    if (state.prFilter !== "") {
      for (const match of fuzzyFilter(state.prFilter, prs, (pr) => pr.title)) {
        titleMatches.set(prKey(match.item), match.positions);
      }
      for (const match of fuzzyFilter(state.prFilter, prs, (pr) => pr.headRefName)) {
        branchMatches.set(prKey(match.item), match.positions);
      }
    }
    const visible = prs.slice(context.prScroll, context.prScroll + layout.listRows);
    visible.forEach((pr, offset) => {
      rows.push(
        prRow(state, context, width, columns, pr, context.prScroll + offset, {
          title: titleMatches.get(prKey(pr)) ?? [],
          branch: branchMatches.get(prKey(pr)) ?? [],
        }),
      );
    });
  }

  for (const { repoId, error } of errors) {
    const repo = state.repos.find((item) => item.id === repoId);
    rows.push(
      fitLine(
        [
          cell(" ", {}),
          cell(glyphs.warn, { fg: theme.red }),
          cell(` ${repo?.name ?? repoId} ${glyphs.sep} `, { fg: theme.muted }),
          cell(truncate(error, Math.max(8, width - 12)), { fg: theme.dim }),
        ],
        width,
      ),
    );
  }
  return rows;
}

function prKey(pr: PullRequest): string {
  return `${pr.repoId}#${pr.number}`;
}

function prDetailLines(state: AppState, layout: ScreenLayout, context: ScreenContext): Line[] {
  const width = layout.width - 2;
  const pr = selectedPr(state);
  if (!pr) {
    // The body already spells the empty state out ("No open PRs authored by
    // you…"); repeating "nothing selected" down here would only add noise.
    return Array.from({ length: layout.detailRows }, () => fitLine([], width));
  }

  const lines: Line[] = [];
  const worktree = prWorktree(state, pr);

  const right: Line = [];
  if (state.prTab === "review") {
    right.push(cell(pr.author, { fg: theme.muted }));
    right.push(cell(" ", {}));
  }
  right.push(cell(`${glyphs.arrow} `, { fg: theme.dim }));
  right.push(cell(pr.baseRefName, { fg: theme.cyan }));
  right.push(cell(` ${glyphs.sep} `, { fg: theme.dim }));
  right.push(cell(`+${pr.additions}`, { fg: theme.green }));
  right.push(cell(` −${pr.deletions}`, { fg: theme.red }));
  right.push(cell(" ", {}));
  lines.push(
    spread(
      [
        cell(" ", {}),
        cell(`#${pr.number} `, { fg: theme.dim }),
        cell(pr.title, { fg: theme.strong, bold: true }),
      ],
      right,
      width,
    ),
  );

  const worktreeLine: Line = [cell(" worktree  ", { fg: theme.dim })];
  if (worktree) {
    worktreeLine.push(
      cell(truncateStart(tildePath(worktree.path, context.home), Math.max(10, width - 34)), {
        fg: theme.muted,
      }),
    );
    worktreeLine.push(cell(` ${glyphs.sep} session `, { fg: theme.dim }));
    worktreeLine.push(
      cell(sessionLabel(state.statuses[worktree.id]?.session), { fg: theme.muted }),
    );
  } else {
    const slug = slugify(prLocalBranch(pr));
    const destination = `${state.config.worktreesDir}/${pr.repoId}/${slug}`;
    worktreeLine.push(cell("none", { fg: theme.ghost }));
    worktreeLine.push(cell(` ${glyphs.sep} `, { fg: theme.dim }));
    worktreeLine.push(cell("Enter", { fg: theme.accent, bold: true }));
    worktreeLine.push(cell(" creates ", { fg: theme.dim }));
    worktreeLine.push(
      cell(truncateStart(tildePath(destination, context.home), Math.max(10, width - 48)), {
        fg: theme.muted,
      }),
    );
    worktreeLine.push(cell(" from ", { fg: theme.dim }));
    worktreeLine.push(cell(`pull/${pr.number}/head`, { fg: theme.cyan }));
    if (pr.isCrossRepository && pr.headRepo) {
      worktreeLine.push(cell(` ${glyphs.sep} fork `, { fg: theme.dim }));
      worktreeLine.push(cell(pr.headRepo, { fg: theme.muted }));
    }
  }
  lines.push(worktreeLine);

  const facts: Line = [];
  if (pr.checks !== "none") {
    facts.push(cell("checks ", { fg: theme.dim }));
    facts.push(
      pr.checks === "pass"
        ? cell(glyphs.check, { fg: theme.green })
        : pr.checks === "fail"
          ? cell(glyphs.cross, { fg: theme.red })
          : cell(glyphs.ellipsis, { fg: theme.yellow }),
    );
  }
  if (pr.reviewDecision !== "none") {
    if (facts.length > 0) facts.push(cell(` ${glyphs.sep} `, { fg: theme.dim }));
    facts.push(cell("review ", { fg: theme.dim }));
    facts.push(
      pr.reviewDecision === "approved"
        ? cell("approved", { fg: theme.green })
        : pr.reviewDecision === "changes_requested"
          ? cell("changes requested", { fg: theme.red })
          : cell("required", { fg: theme.muted }),
    );
  }
  if (pr.labels.length > 0) {
    if (facts.length > 0) facts.push(cell(` ${glyphs.sep} `, { fg: theme.dim }));
    facts.push(cell("labels ", { fg: theme.dim }));
    facts.push(cell(pr.labels.join(", "), { fg: theme.muted }));
  }
  if (facts.length > 0) facts.push(cell(` ${glyphs.sep} `, { fg: theme.dim }));
  facts.push(cell("updated ", { fg: theme.dim }));
  facts.push(cell(relativeTime(pr.updatedAt, context.now), { fg: theme.muted }));
  lines.push([cell(" ", {}), ...facts]);

  lines.push([cell(" ", {}), cell(truncate(pr.url, width - 2), { fg: theme.ghost })]);

  return lines.slice(0, layout.detailRows).map((line) => fitLine(line, width));
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** A rule spanning the whole inner width, with no pane divider junction. */
function fullRule(layout: ScreenLayout): Line {
  return [frameCell(`${box.teeLeft}${repeat(box.horizontal, layout.width - 2)}${box.teeRight}`)];
}

/**
 * The pull request screen replaces the two panes with one full-width body; the
 * frame, the context tabs and the footer are the same chrome as the main screen
 * so switching screens never moves them.
 */
function prScreenLines(state: AppState, layout: ScreenLayout, context: ScreenContext): Line[] {
  const width = layout.width - 2;
  const lines: Line[] = [topFrame(layout), headerLine(state, layout), fullRule(layout)];
  lines.push([
    frameCell(box.vertical),
    ...prsHeader(state, layout, context),
    frameCell(box.vertical),
  ]);

  const bodyRows = prBodyRows(state, layout, context);
  const details = layout.detailRows > 0 ? prDetailLines(state, layout, context) : [];
  const blank = fitLine([], width);

  for (let row = 0; row < layout.bodyRows; row += 1) {
    if (layout.detailRows > 0 && row === layout.listRows) {
      lines.push(fullRule(layout));
      continue;
    }
    const line =
      layout.detailRows > 0 && row > layout.listRows
        ? (details[row - layout.listRows - 1] ?? blank)
        : (bodyRows[row] ?? blank);
    lines.push([frameCell(box.vertical), ...line, frameCell(box.vertical)]);
  }

  lines.push(fullRule(layout));
  lines.push([
    frameCell(box.vertical),
    ...footerContent(state, layout, context),
    frameCell(box.vertical),
  ]);
  lines.push(bottomFrame(layout));
  return lines;
}

/**
 * Build the whole base screen as an array of exactly `height` lines, each
 * exactly `width` cells wide.
 */
export function buildScreen(state: AppState, context: ScreenContext): Line[] {
  const layout = layoutOf(context.width, context.height);
  if (state.screen === "prs") {
    const prLines = prScreenLines(state, layout, context).slice(0, context.height);
    return context.ghosted ? prLines.map(ghostLine) : prLines;
  }
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
