/**
 * Visual language for the swarm popup.
 *
 * The palette is deliberately narrow: one accent for "where the cursor is",
 * green for attached sessions, yellow for anything still running, red only for
 * danger. Everything else is a shade of the same slate so the eye lands on the
 * few cells that changed.
 */
export const theme = {
  /** Box drawing characters of the outer frame and the pane divider. */
  frame: "#3b4261",
  /** Frame around the pane that currently owns the keyboard. */
  frameFocus: "#546389",
  /** App title, key hints, cursor marker. */
  accent: "#7aa2f7",
  /** Regular row text. */
  text: "#c0caf5",
  /** Row text on the cursor row / dialog titles. */
  strong: "#e7ecff",
  /** Secondary text: repo prefixes, labels. */
  muted: "#8b93b8",
  /** Tertiary text: timestamps, paths, hints. */
  dim: "#5d6689",
  /** Background layer text (behind a dialog). */
  ghost: "#3b4261",

  cursorBg: "#2c3c62",
  cursorBgBlur: "#232939",
  cursorFg: "#e7ecff",

  green: "#9ece6a",
  yellow: "#e0af68",
  orange: "#ff9e64",
  red: "#f7768e",
  magenta: "#bb9af7",
  cyan: "#7dcfff",

  dialogBg: "#1b1e2b",
  dialogBorder: "#546389",
  dialogTitle: "#7aa2f7",
  inputBg: "#232739",
  inputFg: "#e7ecff",
  selectionBg: "#2c3c62",
} as const;

export const glyphs = {
  /** tmux session exists and the client is attached to it. */
  attached: "●",
  /** tmux session exists but nobody is looking at it. */
  detached: "◌",
  /** No tmux session. */
  none: "○",
  cursor: "▸",
  sep: "·",
  arrow: "→",
  checked: "x",
  check: "✓",
  private: "◆",
  public: "◇",
  up: "↑",
  down: "↓",
  enter: "⏎",
  tab: "⇥",
  ellipsis: "…",
} as const;

export const box = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
  teeLeft: "├",
  teeRight: "┤",
  teeDown: "┬",
  teeUp: "┴",
} as const;

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function spinnerFrame(tick: number): string {
  return SPINNER[Math.abs(tick) % SPINNER.length] ?? SPINNER[0];
}
