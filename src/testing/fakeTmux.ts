import { SwarmError } from "../core/errors.ts";
import type { TmuxPort, TmuxSession, TmuxWindow } from "../core/ports.ts";

export interface FakeTmuxOptions {
  insideTmux?: boolean;
  currentSession?: string | null;
  sessions?: TmuxSession[];
  windows?: TmuxWindow[];
}

export type FakeTmuxCall = { method: keyof TmuxPort; args: unknown[] };

export type FakeTmux = TmuxPort & {
  calls: FakeTmuxCall[];
  sessions: Map<string, TmuxSession>;
  windows: Map<string, TmuxWindow[]>;
  switched: string[];
  sentKeys: Array<{ target: string; keys: string[]; enter: boolean }>;
};

function copyWindow(window: TmuxWindow): TmuxWindow {
  return { ...window, panes: window.panes.map((pane) => ({ ...pane })) };
}

export function createFakeTmux(options: FakeTmuxOptions = {}): FakeTmux {
  const calls: FakeTmuxCall[] = [];
  const sessions = new Map(
    (options.sessions ?? []).map((session) => [session.name, { ...session }]),
  );
  const windows = new Map<string, TmuxWindow[]>();
  for (const window of options.windows ?? []) {
    const entries = windows.get(window.session) ?? [];
    entries.push(copyWindow(window));
    windows.set(window.session, entries);
  }
  const switched: string[] = [];
  const sentKeys: Array<{ target: string; keys: string[]; enter: boolean }> = [];
  let activeSession = options.currentSession ?? null;
  const isInside = options.insideTmux ?? true;

  const updateWindowCount = (session: string): void => {
    const entry = sessions.get(session);
    if (entry) entry.windows = windows.get(session)?.length ?? 0;
  };

  return {
    calls,
    sessions,
    windows,
    switched,
    sentKeys,
    insideTmux() {
      return isInside;
    },
    async currentSession() {
      calls.push({ method: "currentSession", args: [] });
      return activeSession;
    },
    async listSessions() {
      calls.push({ method: "listSessions", args: [] });
      return [...sessions.values()].map((session) => ({ ...session }));
    },
    async listWindows(session) {
      calls.push({ method: "listWindows", args: [session] });
      const listed = session ? (windows.get(session) ?? []) : [...windows.values()].flat();
      return listed.map(copyWindow);
    },
    async hasSession(name) {
      calls.push({ method: "hasSession", args: [name] });
      return sessions.has(name);
    },
    async newSession(opts) {
      calls.push({ method: "newSession", args: [opts] });
      const now = Date.now();
      sessions.set(opts.name, {
        name: opts.name,
        attached: false,
        windows: 1,
        createdAt: now,
        lastActivityAt: now,
      });
      windows.set(opts.name, [
        {
          session: opts.name,
          index: 0,
          name: opts.windowName,
          active: true,
          panes: opts.command
            ? [
                {
                  id: "%0",
                  pid: 1,
                  currentCommand: opts.command.split(/\s/u, 1)[0] ?? "",
                  currentPath: opts.cwd ?? "",
                },
              ]
            : [],
        },
      ]);
    },
    async newWindow(opts) {
      calls.push({ method: "newWindow", args: [opts] });
      const entries = windows.get(opts.session) ?? [];
      const index = entries.reduce((maximum, window) => Math.max(maximum, window.index), -1) + 1;
      entries.push({
        session: opts.session,
        index,
        name: opts.name,
        active: false,
        panes: [],
      });
      windows.set(opts.session, entries);
      updateWindowCount(opts.session);
      return index;
    },
    async sendKeys(target, keys, opts) {
      calls.push({ method: "sendKeys", args: [target, keys, opts] });
      sentKeys.push({ target, keys: [...keys], enter: opts?.enter ?? false });
    },
    async swapWindows(session, a, b) {
      calls.push({ method: "swapWindows", args: [session, a, b] });
      for (const window of windows.get(session) ?? []) {
        if (window.index === a) window.index = b;
        else if (window.index === b) window.index = a;
      }
    },
    async selectWindow(session, index) {
      calls.push({ method: "selectWindow", args: [session, index] });
      for (const window of windows.get(session) ?? []) window.active = window.index === index;
    },
    async killWindow(session, index) {
      calls.push({ method: "killWindow", args: [session, index] });
      windows.set(
        session,
        (windows.get(session) ?? []).filter((window) => window.index !== index),
      );
      updateWindowCount(session);
      if ((windows.get(session)?.length ?? 0) === 0) {
        sessions.delete(session);
        windows.delete(session);
        if (activeSession === session) activeSession = null;
      }
    },
    async killSession(name) {
      calls.push({ method: "killSession", args: [name] });
      if (!sessions.has(name)) {
        throw new SwarmError("tmux", `Session does not exist: ${name}`);
      }
      sessions.delete(name);
      windows.delete(name);
      if (activeSession === name) activeSession = null;
    },
    async killSessionIfPresent(name) {
      calls.push({ method: "killSessionIfPresent", args: [name] });
      sessions.delete(name);
      windows.delete(name);
      if (activeSession === name) activeSession = null;
    },
    async switchClient(session) {
      calls.push({ method: "switchClient", args: [session] });
      switched.push(session);
      for (const entry of sessions.values()) entry.attached = entry.name === session;
      activeSession = session;
    },
    async attach(session): Promise<never> {
      calls.push({ method: "attach", args: [session] });
      throw new SwarmError("unsupported", "FakeTmux cannot attach the current process");
    },
    async displayMessage(message) {
      calls.push({ method: "displayMessage", args: [message] });
    },
  };
}
