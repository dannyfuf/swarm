import { glyphs, theme } from "./theme.ts";

/**
 * A styled run of characters. The whole main screen is composed out of these so
 * that every column lands on an exact terminal cell: the frame, the panes and
 * the dividers are drawn by us instead of by nested bordered boxes, which is the
 * only way to get real `├ ┬ ┤` junctions and stable column alignment.
 *
 * Every glyph used by the UI is single width, so `length` is the display width.
 */
export interface Cell {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export type Line = Cell[];

export interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export function cell(text: string, style: Style = {}): Cell {
  return { text, ...style };
}

export function lineWidth(line: Line): number {
  let total = 0;
  for (const part of line) total += part.text.length;
  return total;
}

export function repeat(character: string, count: number): string {
  return count > 0 ? character.repeat(count) : "";
}

/** Truncate with an ellipsis so the result never exceeds `width`. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return glyphs.ellipsis;
  return `${text.slice(0, width - 1)}${glyphs.ellipsis}`;
}

/** Truncate from the front, keeping the tail (used for filesystem paths). */
export function truncateStart(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return glyphs.ellipsis;
  return `${glyphs.ellipsis}${text.slice(text.length - width + 1)}`;
}

export function pad(text: string, width: number): string {
  const fitted = truncate(text, width);
  return fitted + repeat(" ", width - fitted.length);
}

export function padStart(text: string, width: number): string {
  const fitted = truncate(text, width);
  return repeat(" ", width - fitted.length) + fitted;
}

/** Cut or pad a whole line so it occupies exactly `width` cells. */
export function fitLine(line: Line, width: number, style: Style = {}): Line {
  const result: Line = [];
  let used = 0;
  for (const part of line) {
    if (used >= width) break;
    const room = width - used;
    if (part.text.length <= room) {
      result.push(part);
      used += part.text.length;
    } else {
      result.push({ ...part, text: truncate(part.text, room) });
      used = width;
    }
  }
  if (used < width) result.push(cell(repeat(" ", width - used), style));
  return result;
}

/** Lay `left` against the start and `right` against the end of `width` cells. */
export function spread(left: Line, right: Line, width: number, style: Style = {}): Line {
  const rightWidth = Math.min(lineWidth(right), width);
  const leftWidth = Math.max(0, width - rightWidth - 1);
  const leftFitted = fitLine(left, leftWidth, style);
  const gap = width - leftWidth - rightWidth;
  return [...leftFitted, cell(repeat(" ", Math.max(0, gap)), style), ...right];
}

/** Apply a background to every cell of a line (cursor row highlight). */
export function withBackground(line: Line, bg: string, fg?: string): Line {
  return line.map((part) => ({ ...part, bg, fg: fg ?? part.fg }));
}

/** Flatten a line to plain text; used by tests and by width math. */
export function lineText(line: Line): string {
  return line.map((part) => part.text).join("");
}

/**
 * Push the whole screen into the background while a dialog is open: one flat
 * shade, no highlights, so the dialog is unmistakably the focused surface.
 */
export function ghostLine(line: Line): Line {
  return line.map((part) => ({ text: part.text, fg: theme.ghost }));
}

/**
 * Split `text` into cells so that the characters at `positions` (fuzzy match
 * offsets, relative to `offset`) get the match style.
 */
export function highlight(
  text: string,
  positions: readonly number[],
  base: Style,
  match: Style,
  offset = 0,
): Line {
  if (positions.length === 0) return [cell(text, base)];
  const marked = new Set(positions.map((position) => position + offset));
  const result: Line = [];
  let run = "";
  let runMatched = false;
  for (let index = 0; index < text.length; index += 1) {
    const matched = marked.has(index);
    if (run !== "" && matched !== runMatched) {
      result.push(cell(run, runMatched ? match : base));
      run = "";
    }
    runMatched = matched;
    run += text[index] ?? "";
  }
  if (run !== "") result.push(cell(run, runMatched ? match : base));
  return result;
}
