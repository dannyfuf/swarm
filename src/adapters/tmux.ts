import { SwarmError } from "../core/errors.ts";
import type {
  Logger,
  Shell,
  ShellResult,
  TmuxPort,
  TmuxSession,
  TmuxWindow,
} from "../core/ports.ts";

const PANE_FORMAT =
  "#{session_name}\t#{window_index}\t#{window_name}\t#{window_active}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}";
const SESSION_FORMAT =
  "#{session_name}\t#{session_attached}\t#{session_windows}\t#{session_created}\t#{session_activity}";

function exactTarget(name: string): string {
  return `=${name}`;
}

const UTF8_LOCALE = /utf-?8/iu;

/**
 * tmux sanitizes command output (tabs become `_`) for clients whose locale is
 * not UTF-8, which breaks the tab-separated formats above. `-u` forces UTF-8
 * output regardless of the locale; the env tweak below is a belt-and-braces
 * fallback that only fills in LC_CTYPE when no UTF-8 locale is configured.
 */
export function tmuxLocaleEnv(env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  if (UTF8_LOCALE.test(locale)) return undefined;
  return { LC_CTYPE: "C.UTF-8" };
}

function failureMessage(args: string[], result: ShellResult): string {
  const detail = result.stderr.trim() || result.stdout.trim() || "no error output";
  return `tmux ${args[0] ?? "command"} failed with exit code ${result.code}: ${detail}`;
}

export function createTmux(
  shell: Shell,
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env,
): TmuxPort {
  const log = logger.child("tmux");
  const localeEnv = tmuxLocaleEnv(env);
  const runOptions = localeEnv ? { env: localeEnv } : undefined;

  const invoke = async (args: string[]): Promise<ShellResult> => {
    try {
      return await shell.run("tmux", ["-u", ...args], runOptions);
    } catch (cause) {
      log.error("tmux command could not be run", { args, cause });
      throw new SwarmError("tmux", `tmux ${args[0] ?? "command"} could not be run`, { cause });
    }
  };

  const run = async (args: string[]): Promise<ShellResult> => {
    const result = await invoke(args);
    if (result.code !== 0) {
      log.error("tmux command failed", {
        args,
        code: result.code,
        stderr: result.stderr,
      });
      throw new SwarmError("tmux", failureMessage(args, result), { cause: result });
    }
    return result;
  };

  const parseError = (description: string, line: string): SwarmError =>
    new SwarmError("tmux", `Could not parse ${description} from tmux output: ${line}`);

  return {
    insideTmux() {
      return !!env.TMUX;
    },

    async currentSession() {
      if (!env.TMUX) return null;
      // The TUI can run in a popup or a dedicated control window. In both
      // cases the session to sleep is the one shown by the invoking client,
      // not the session that owns the TUI pane itself.
      const result = await run(["display-message", "-p", "#{client_session}"]);
      return result.stdout.trim() || null;
    },

    async listSessions() {
      const args = ["list-sessions", "-F", SESSION_FORMAT];
      const result = await invoke(args);
      if (result.code === 1 && result.stderr.toLowerCase().includes("no server running")) return [];
      if (result.code !== 0) {
        log.error("tmux command failed", {
          args,
          code: result.code,
          stderr: result.stderr,
        });
        throw new SwarmError("tmux", failureMessage(args, result), { cause: result });
      }

      const sessions: TmuxSession[] = [];
      for (const line of result.stdout.split("\n")) {
        if (!line) continue;
        const fields = line.split("\t");
        if (fields.length !== 5) throw parseError("session", line);
        const [name, attachedText, windowsText, createdText, activityText] = fields;
        const windows = Number(windowsText);
        const createdAt = Number(createdText);
        const lastActivityAt = Number(activityText);
        if (
          name === undefined ||
          attachedText === undefined ||
          !Number.isInteger(windows) ||
          !Number.isFinite(createdAt) ||
          !Number.isFinite(lastActivityAt)
        ) {
          throw parseError("session", line);
        }
        sessions.push({
          name,
          attached: Number(attachedText) > 0,
          windows,
          createdAt,
          lastActivityAt,
        });
      }
      return sessions;
    },

    async listWindows(session) {
      const args = session
        ? ["list-panes", "-t", exactTarget(session), "-s", "-F", PANE_FORMAT]
        : ["list-panes", "-a", "-F", PANE_FORMAT];
      const result = await run(args);
      const windows = new Map<string, TmuxWindow>();

      for (const line of result.stdout.split("\n")) {
        if (!line) continue;
        const fields = line.split("\t");
        if (fields.length !== 8) throw parseError("pane", line);
        const [sessionName, indexText, name, activeText, id, pidText, currentCommand, currentPath] =
          fields;
        const index = Number(indexText);
        const pid = Number(pidText);
        if (
          sessionName === undefined ||
          name === undefined ||
          activeText === undefined ||
          id === undefined ||
          currentCommand === undefined ||
          currentPath === undefined ||
          !Number.isInteger(index) ||
          !Number.isInteger(pid)
        ) {
          throw parseError("pane", line);
        }

        const key = `${sessionName}\0${index}`;
        let window = windows.get(key);
        if (!window) {
          window = {
            session: sessionName,
            index,
            name,
            active: activeText === "1",
            panes: [],
          };
          windows.set(key, window);
        }
        window.panes.push({ id, pid, currentCommand, currentPath });
      }

      return [...windows.values()];
    },

    async hasSession(name) {
      const args = ["has-session", "-t", exactTarget(name)];
      const result = await invoke(args);
      if (result.code === 0) return true;
      if (result.code === 1) return false;
      log.error("tmux command failed", { args, code: result.code, stderr: result.stderr });
      throw new SwarmError("tmux", failureMessage(args, result), { cause: result });
    },

    async newSession({ name, cwd, windowName, command }) {
      await run([
        "new-session",
        "-d",
        "-s",
        name,
        "-n",
        windowName,
        ...(cwd ? ["-c", cwd] : []),
        ...(command ? [command] : []),
      ]);
    },

    async newWindow({ session, name, cwd }) {
      const result = await run([
        "new-window",
        "-d",
        "-t",
        `${exactTarget(session)}:`,
        "-n",
        name,
        "-c",
        cwd,
        "-P",
        "-F",
        "#{window_index}",
      ]);
      const index = Number(result.stdout.trim());
      if (!Number.isInteger(index)) throw parseError("window index", result.stdout.trim());
      return index;
    },

    async sendKeys(target, keys, opts) {
      await run(["send-keys", "-t", target, ...keys, ...(opts?.enter ? ["Enter"] : [])]);
    },

    async swapWindows(session, a, b) {
      await run([
        "swap-window",
        "-d",
        "-s",
        `${exactTarget(session)}:${a}`,
        "-t",
        `${exactTarget(session)}:${b}`,
      ]);
    },

    async selectWindow(session, index) {
      await run(["select-window", "-t", `${exactTarget(session)}:${index}`]);
    },

    async killWindow(session, index) {
      await run(["kill-window", "-t", `${exactTarget(session)}:${index}`]);
    },

    async killSession(name) {
      await run(["kill-session", "-t", exactTarget(name)]);
    },

    async killSessionIfPresent(name) {
      const args = ["kill-session", "-t", exactTarget(name)];
      const result = await invoke(args);
      if (result.code === 0) return;
      const detail = `${result.stderr}\n${result.stdout}`;
      if (/(?:can't find session|session not found)/iu.test(detail)) return;
      log.error("tmux command failed", { args, code: result.code, stderr: result.stderr });
      throw new SwarmError("tmux", failureMessage(args, result), { cause: result });
    },

    async setOption(target, name, value) {
      await run(["set-option", "-t", exactTarget(target), name, value]);
    },

    async switchClient(session) {
      await run(["switch-client", "-t", exactTarget(session)]);
    },

    async attach(session): Promise<never> {
      const args = ["-u", "attach-session", "-t", exactTarget(session)];
      try {
        return await shell.exec("tmux", args);
      } catch (cause) {
        log.error("tmux attach could not be run", { args, cause });
        throw new SwarmError("tmux", "tmux attach-session could not be run", { cause });
      }
    },

    async displayMessage(message) {
      await run(["display-message", message]);
    },
  };
}
