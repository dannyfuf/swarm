import type { Command, KeyEvent, Mode, Pane } from "../core/app.ts";

export interface KeyContext {
  hasFilter: boolean;
}

export interface KeyResolution {
  command: Command;
  pending: string;
}

export const KEY_HINTS: Record<Pane, Array<{ key: string; label: string }>> = {
  repos: [
    { key: "Enter", label: "worktrees" },
    { key: "n", label: "clone" },
    { key: "d", label: "delete" },
    { key: "m", label: "move" },
    { key: "N", label: "new context" },
    { key: ":", label: "commands" },
    { key: ",", label: "settings" },
    { key: "?", label: "help" },
    { key: "q", label: "quit" },
  ],
  worktrees: [
    { key: "Enter", label: "open" },
    { key: "O", label: "open, keep previous" },
    { key: "n", label: "new" },
    { key: "d", label: "delete" },
    { key: "s", label: "sleep" },
    { key: "K", label: "kill" },
    { key: "/", label: "filter" },
    { key: "y", label: "copy path" },
    { key: ":", label: "commands" },
    { key: ",", label: "settings" },
    { key: "?", label: "help" },
    { key: "q", label: "quit" },
  ],
};

export const COMMANDS: Array<{ command: Command; label: string; keys: string }> = [
  { command: "down", label: "Move down", keys: "j / ↓" },
  { command: "up", label: "Move up", keys: "k / ↑" },
  { command: "top", label: "Jump to top", keys: "gg" },
  { command: "bottom", label: "Jump to bottom", keys: "G" },
  { command: "halfDown", label: "Move half a page down", keys: "ctrl-d" },
  { command: "halfUp", label: "Move half a page up", keys: "ctrl-u" },
  { command: "left", label: "Focus repos", keys: "h / ← / S-Tab" },
  { command: "right", label: "Focus worktrees", keys: "l / → / Tab" },
  { command: "open", label: "Open selected", keys: "Enter / o" },
  { command: "openKeep", label: "Open and keep previous", keys: "O" },
  { command: "new", label: "Create or clone", keys: "n" },
  { command: "newContext", label: "Create context", keys: "N" },
  { command: "delete", label: "Delete selected", keys: "d" },
  { command: "deleteContext", label: "Delete active context", keys: "D" },
  { command: "sleep", label: "Sleep worktree", keys: "s" },
  { command: "kill", label: "Kill session", keys: "K" },
  { command: "move", label: "Move repo", keys: "m" },
  { command: "refresh", label: "Refresh", keys: "r" },
  { command: "filter", label: "Filter worktrees", keys: "/" },
  { command: "palette", label: "Command palette", keys: ":" },
  { command: "settings", label: "Settings", keys: "," },
  { command: "nextContext", label: "Next context", keys: "gt" },
  { command: "prevContext", label: "Previous context", keys: "gT" },
  { command: "yank", label: "Copy worktree path", keys: "y" },
  { command: "help", label: "Help", keys: "?" },
  { command: "clearFilter", label: "Clear retained filter", keys: "Esc" },
  { command: "quit", label: "Quit", keys: "q / Esc / ctrl-c" },
];

function isKey(event: KeyEvent, name: string): boolean {
  return event.name.toLowerCase() === name.toLowerCase();
}

function isUppercaseKey(event: KeyEvent, name: string): boolean {
  return event.name === name.toUpperCase() || (event.name === name.toLowerCase() && event.shift);
}

function none(pending = ""): KeyResolution {
  return { command: "none", pending };
}

function resolveNormalKey(event: KeyEvent, context: KeyContext): KeyResolution {
  if (event.ctrl) {
    if (isKey(event, "c")) return { command: "quit", pending: "" };
    if (isKey(event, "d")) return { command: "halfDown", pending: "" };
    if (isKey(event, "u")) return { command: "halfUp", pending: "" };
    return none();
  }

  if (isKey(event, "escape") || isKey(event, "esc")) {
    return { command: context.hasFilter ? "clearFilter" : "quit", pending: "" };
  }
  if (isKey(event, "return") || isKey(event, "enter")) {
    return { command: "open", pending: "" };
  }
  if (isKey(event, "tab")) {
    return { command: event.shift ? "left" : "right", pending: "" };
  }
  if (isUppercaseKey(event, "g")) return { command: "bottom", pending: "" };
  if (isUppercaseKey(event, "o")) return { command: "openKeep", pending: "" };
  if (isUppercaseKey(event, "n")) return { command: "newContext", pending: "" };
  if (isUppercaseKey(event, "d")) return { command: "deleteContext", pending: "" };
  if (isUppercaseKey(event, "k")) return { command: "kill", pending: "" };
  if (event.shift || event.meta) return none();
  if (isKey(event, "down") || isKey(event, "j")) return { command: "down", pending: "" };
  if (isKey(event, "up") || isKey(event, "k")) return { command: "up", pending: "" };
  if (isKey(event, "left") || isKey(event, "h")) return { command: "left", pending: "" };
  if (isKey(event, "right") || isKey(event, "l")) return { command: "right", pending: "" };
  if (isKey(event, "g")) return none("g");

  const digit = Number(event.name);
  if (/^[1-9]$/.test(event.name) && Number.isInteger(digit)) {
    return { command: `context:${digit}`, pending: "" };
  }

  const commands: Record<string, Command> = {
    o: "open",
    n: "new",
    d: "delete",
    s: "sleep",
    m: "move",
    r: "refresh",
    "/": "filter",
    ":": "palette",
    ",": "settings",
    "?": "help",
    y: "yank",
    q: "quit",
  };
  return { command: commands[event.name] ?? "none", pending: "" };
}

export function resolveKey(
  mode: Mode,
  pending: string,
  event: KeyEvent,
  context: KeyContext,
): KeyResolution {
  if (mode === "dialog") {
    return event.ctrl && isKey(event, "c") ? { command: "quit", pending: "" } : none();
  }

  if (mode === "filter") {
    if (event.ctrl && isKey(event, "c")) return { command: "quit", pending: "" };
    if (isKey(event, "return") || isKey(event, "enter")) {
      return { command: "open", pending: "" };
    }
    if ((event.ctrl && isKey(event, "n")) || isKey(event, "down")) {
      return { command: "down", pending: "" };
    }
    if ((event.ctrl && isKey(event, "p")) || isKey(event, "up")) {
      return { command: "up", pending: "" };
    }
    return none();
  }

  if (pending === "g") {
    if (!event.ctrl && event.name === "g" && !event.shift) {
      return { command: "top", pending: "" };
    }
    if (!event.ctrl && isKey(event, "t")) {
      return {
        command: isUppercaseKey(event, "t") ? "prevContext" : "nextContext",
        pending: "",
      };
    }
  }

  return resolveNormalKey(event, context);
}
