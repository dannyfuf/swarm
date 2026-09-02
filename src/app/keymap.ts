import type { AppState, Command, KeyEvent, Mode, Pane } from "../core/app.ts";

export interface KeyContext {
  hasFilter: boolean;
  screen: AppState["screen"];
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
    { key: "p", label: "prs" },
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
    { key: "p", label: "prs" },
    { key: ":", label: "commands" },
    { key: ",", label: "settings" },
    { key: "?", label: "help" },
    { key: "q", label: "quit" },
  ],
};

export const COMMANDS: Array<{
  command: Command;
  label: string;
  keys: string;
  screens: Array<AppState["screen"]>;
}> = [
  { command: "down", label: "Move down", keys: "j / ↓", screens: ["main", "prs"] },
  { command: "up", label: "Move up", keys: "k / ↑", screens: ["main", "prs"] },
  { command: "top", label: "Jump to top", keys: "gg", screens: ["main", "prs"] },
  { command: "bottom", label: "Jump to bottom", keys: "G", screens: ["main", "prs"] },
  {
    command: "halfDown",
    label: "Move half a page down",
    keys: "ctrl-d",
    screens: ["main", "prs"],
  },
  {
    command: "halfUp",
    label: "Move half a page up",
    keys: "ctrl-u",
    screens: ["main", "prs"],
  },
  { command: "left", label: "Focus repos", keys: "h / ← / S-Tab", screens: ["main"] },
  { command: "right", label: "Focus worktrees", keys: "l / → / Tab", screens: ["main"] },
  { command: "prevTab", label: "Previous PR tab", keys: "S-Tab / h / ←", screens: ["prs"] },
  { command: "nextTab", label: "Next PR tab", keys: "Tab / l / →", screens: ["prs"] },
  { command: "open", label: "Open selected", keys: "Enter / o", screens: ["main", "prs"] },
  {
    command: "openKeep",
    label: "Open and keep previous",
    keys: "O",
    screens: ["main", "prs"],
  },
  { command: "prs", label: "Pull requests", keys: "p", screens: ["main"] },
  { command: "back", label: "Back to main", keys: "p / q / Esc", screens: ["prs"] },
  { command: "browse", label: "Open in browser", keys: "b", screens: ["prs"] },
  { command: "new", label: "Create or clone", keys: "n", screens: ["main"] },
  { command: "newContext", label: "Create context", keys: "N", screens: ["main"] },
  { command: "delete", label: "Delete selected", keys: "d", screens: ["main"] },
  { command: "deleteContext", label: "Delete active context", keys: "D", screens: ["main"] },
  { command: "sleep", label: "Sleep worktree", keys: "s", screens: ["main"] },
  { command: "kill", label: "Kill session", keys: "K", screens: ["main"] },
  { command: "move", label: "Move repo", keys: "m", screens: ["main"] },
  { command: "refresh", label: "Refresh", keys: "r", screens: ["main", "prs"] },
  { command: "filter", label: "Filter", keys: "/", screens: ["main", "prs"] },
  { command: "palette", label: "Command palette", keys: ":", screens: ["main", "prs"] },
  { command: "settings", label: "Settings", keys: ",", screens: ["main", "prs"] },
  { command: "nextContext", label: "Next context", keys: "gt", screens: ["main", "prs"] },
  { command: "prevContext", label: "Previous context", keys: "gT", screens: ["main", "prs"] },
  { command: "yank", label: "Copy", keys: "y", screens: ["main", "prs"] },
  { command: "help", label: "Help", keys: "?", screens: ["main", "prs"] },
  {
    command: "clearFilter",
    label: "Clear retained filter",
    keys: "Esc",
    screens: ["main", "prs"],
  },
  { command: "quit", label: "Quit", keys: "q / Esc / ctrl-c", screens: ["main", "prs"] },
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
    return {
      command: context.hasFilter ? "clearFilter" : context.screen === "prs" ? "back" : "quit",
      pending: "",
    };
  }
  if (isKey(event, "return") || isKey(event, "enter")) {
    return { command: "open", pending: "" };
  }
  if (isKey(event, "tab")) {
    if (context.screen === "prs") {
      return { command: event.shift ? "prevTab" : "nextTab", pending: "" };
    }
    return { command: event.shift ? "left" : "right", pending: "" };
  }
  if (isUppercaseKey(event, "g")) return { command: "bottom", pending: "" };
  if (isUppercaseKey(event, "o")) return { command: "openKeep", pending: "" };
  if (context.screen === "main" && isUppercaseKey(event, "n")) {
    return { command: "newContext", pending: "" };
  }
  if (context.screen === "main" && isUppercaseKey(event, "d")) {
    return { command: "deleteContext", pending: "" };
  }
  if (context.screen === "main" && isUppercaseKey(event, "k")) {
    return { command: "kill", pending: "" };
  }
  if (event.shift || event.meta) return none();
  if (isKey(event, "down") || isKey(event, "j")) return { command: "down", pending: "" };
  if (isKey(event, "up") || isKey(event, "k")) return { command: "up", pending: "" };
  if (isKey(event, "left") || isKey(event, "h")) {
    return { command: context.screen === "prs" ? "prevTab" : "left", pending: "" };
  }
  if (isKey(event, "right") || isKey(event, "l")) {
    return { command: context.screen === "prs" ? "nextTab" : "right", pending: "" };
  }
  if (isKey(event, "g")) return none("g");

  const digit = Number(event.name);
  if (/^[1-9]$/.test(event.name) && Number.isInteger(digit)) {
    return { command: `context:${digit}`, pending: "" };
  }

  const mainCommands: Record<string, Command> = {
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
    p: "prs",
  };
  const prCommands: Record<string, Command> = {
    o: "open",
    b: "browse",
    p: "back",
    q: "back",
    r: "refresh",
    "/": "filter",
    ":": "palette",
    ",": "settings",
    "?": "help",
    y: "yank",
  };
  const commands = context.screen === "prs" ? prCommands : mainCommands;
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
