import type { SessionState, WorktreeStatus } from "../core/types.ts";
import { glyphs, theme } from "./theme.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const YEAR = 365 * DAY;

/**
 * Compact recency, never wider than 7 cells ("52w ago"), so the last column of
 * the worktree list stays perfectly right aligned.
 */
export function relativeTime(iso: string | undefined, now: number): string {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "never";
  const delta = now - then;
  if (delta < 0) return "now";
  if (delta < 45_000) return "now";
  if (delta < HOUR) return `${Math.max(1, Math.round(delta / MINUTE))}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < WEEK) return `${Math.floor(delta / DAY)}d ago`;
  if (delta < YEAR) return `${Math.floor(delta / WEEK)}w ago`;
  return `${Math.floor(delta / YEAR)}y ago`;
}

/** Replace the home prefix with `~` so paths fit the detail box. */
export function tildePath(path: string, home: string): string {
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

export interface StateGlyph {
  char: string;
  fg: string;
}

export function stateGlyph(session: SessionState | undefined): StateGlyph {
  if (session === "attached") return { char: glyphs.attached, fg: theme.green };
  if (session === "detached") return { char: glyphs.detached, fg: theme.yellow };
  return { char: glyphs.none, fg: theme.dim };
}

/** "claude · :3000" — what is alive inside the session, in one glance. */
export function runningLabel(status: WorktreeStatus | undefined): string {
  if (!status || status.running.length === 0) return "";
  return status.running.join(` ${glyphs.sep} `);
}

/** The strongest session state across a group of worktrees (for repo rows). */
export function aggregateSession(states: Array<SessionState | undefined>): SessionState {
  if (states.includes("attached")) return "attached";
  if (states.includes("detached")) return "detached";
  return "none";
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
