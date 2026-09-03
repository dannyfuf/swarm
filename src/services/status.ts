import type {
  ConfigPort,
  Logger,
  ProcessPort,
  ProcInfo,
  TmuxPort,
  TmuxWindow,
} from "../core/ports.ts";
import type { StatusService } from "../core/services.ts";
import { type Worktree, type WorktreeStatus, worktreeHost } from "../core/types.ts";
import { matchKeepAlive } from "./sessions.ts";

export interface StatusServiceDependencies {
  tmux: TmuxPort;
  process: ProcessPort;
  config: ConfigPort;
  logger: Logger;
}

function uniqueProcesses(processes: ProcInfo[]): ProcInfo[] {
  const byPid = new Map<number, ProcInfo>();
  for (const process of processes) byPid.set(process.pid, process);
  return [...byPid.values()];
}

export function createStatusService({
  tmux,
  process,
  config,
  logger,
}: StatusServiceDependencies): StatusService {
  const reportFailure = (area: string, error: unknown): void => {
    try {
      logger.error(`Failed to collect ${area} status`, { error });
    } catch {
      // Status collection remains best-effort even when logging is unavailable.
    }
  };

  return {
    async snapshot(worktrees) {
      const localWorktrees = worktrees.filter((worktree) => worktreeHost(worktree) === "local");
      const [configResult, sessionsResult, windowsResult, processResult] = await Promise.allSettled(
        [config.load(), tmux.listSessions(), tmux.listWindows(), process.snapshot()],
      );
      if (configResult.status === "rejected") reportFailure("configuration", configResult.reason);
      if (sessionsResult.status === "rejected")
        reportFailure("tmux session", sessionsResult.reason);
      if (windowsResult.status === "rejected") reportFailure("tmux window", windowsResult.reason);
      if (processResult.status === "rejected") reportFailure("process", processResult.reason);

      const sessions = sessionsResult.status === "fulfilled" ? sessionsResult.value : [];
      const windows = windowsResult.status === "fulfilled" ? windowsResult.value : [];
      const processSnapshot = processResult.status === "fulfilled" ? processResult.value : [];
      const rules = configResult.status === "fulfilled" ? configResult.value.sleep.keepAlive : [];
      const worktreeSessions = new Set(localWorktrees.map(({ session }) => session));
      const swarmWindows = windows.filter(({ session }) => worktreeSessions.has(session));
      const trees = new Map<TmuxWindow, ProcInfo[]>();

      if (processResult.status === "fulfilled") {
        for (const window of swarmWindows) {
          trees.set(
            window,
            uniqueProcesses(
              window.panes.flatMap((pane) => process.descendants(pane.pid, processSnapshot)),
            ),
          );
        }
      }

      const descendantPids = [
        ...new Set([...trees.values()].flatMap((tree) => tree.map(({ pid }) => pid))),
      ];
      let ports = new Map<number, number[]>();
      if (descendantPids.length > 0) {
        try {
          ports = await process.listeningPorts(descendantPids);
        } catch (error) {
          reportFailure("listening-port", error);
        }
      }
      const sessionsByName = new Map(sessions.map((session) => [session.name, session]));
      const result = new Map<Worktree["id"], WorktreeStatus>();

      for (const worktree of localWorktrees) {
        const tmuxSession = sessionsByName.get(worktree.session);
        const sessionWindows = swarmWindows
          .filter(({ session }) => session === worktree.session)
          .sort((left, right) => left.index - right.index);
        const statusWindows = sessionWindows.map((window) => ({
          index: window.index,
          name: window.name,
          command: window.panes[0]?.currentCommand ?? "",
          keepAlive: matchKeepAlive(rules, trees.get(window) ?? [], ports),
        }));
        const running = [...new Set(statusWindows.flatMap(({ keepAlive }) => keepAlive))];
        result.set(worktree.id, {
          worktreeId: worktree.id,
          session: tmuxSession
            ? tmuxSession.attached
              ? "attached"
              : "detached"
            : sessionWindows.length > 0
              ? "detached"
              : "none",
          windows: statusWindows,
          running,
        });
      }

      return result;
    },
  };
}
