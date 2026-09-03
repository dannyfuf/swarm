import { type ErrorCode, SwarmError } from "../core/errors.ts";
import { proxySessionName } from "../core/paths.ts";
import type {
  Clock,
  ConfigPort,
  Logger,
  ProcessPort,
  ProcInfo,
  StatePort,
  TmuxPort,
  TmuxWindow,
} from "../core/ports.ts";
import { sshInteractiveCommand } from "../core/remote.ts";
import type {
  RemoteHostService,
  SessionService,
  UnmountReport,
  WorktreeService,
} from "../core/services.ts";
import { type KeepAliveRule, resolveWindows, type Worktree, worktreeHost } from "../core/types.ts";

export interface SessionServiceDependencies {
  tmux: TmuxPort;
  process: ProcessPort;
  config: ConfigPort;
  state: StatePort;
  worktrees: WorktreeService;
  clock: Clock;
  logger: Logger;
  sleep?: (ms: number) => Promise<void>;
  remoteHosts?: RemoteHostService;
}

const defaultSleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
};

function serviceError(error: unknown, code: ErrorCode, message: string): SwarmError {
  if (error instanceof SwarmError) return error;
  return new SwarmError(code, message, { cause: error });
}

async function attempt<T>(
  operation: () => Promise<T>,
  code: ErrorCode,
  message: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw serviceError(error, code, message);
  }
}

function uniqueProcesses(processes: ProcInfo[]): ProcInfo[] {
  const byPid = new Map<number, ProcInfo>();
  for (const process of processes) byPid.set(process.pid, process);
  return [...byPid.values()];
}

function enabledValidRules(rules: KeepAliveRule[], logger: Logger): KeepAliveRule[] {
  return rules.filter((rule) => {
    if (!rule.enabled) return false;
    if (rule.kind !== "process") return true;
    try {
      new RegExp(rule.pattern, "i");
      return true;
    } catch (error) {
      logger.warn("Skipping keep-alive rule with invalid regex", {
        ruleId: rule.id,
        pattern: rule.pattern,
        error,
      });
      return false;
    }
  });
}

export function matchKeepAlive(
  rules: KeepAliveRule[],
  tree: ProcInfo[],
  ports: Map<number, number[]>,
): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  const treePids = new Set(tree.map(({ pid }) => pid));

  const add = (label: string): void => {
    if (seen.has(label)) return;
    seen.add(label);
    labels.push(label);
  };

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.kind === "process") {
      try {
        const pattern = new RegExp(rule.pattern, "i");
        if (tree.some(({ command }) => pattern.test(command))) add(rule.label);
      } catch {
        // Invalid user patterns are ignored; callers with a logger warn before matching.
      }
      continue;
    }

    const matchingPorts = [...ports.entries()]
      .filter(([pid]) => treePids.has(pid))
      .flatMap(([, processPorts]) => processPorts)
      .sort((left, right) => left - right);
    for (const port of matchingPorts) add(`:${port}`);
  }

  return labels;
}

function nvimPanes(window: TmuxWindow): TmuxWindow["panes"] {
  return window.panes.filter(({ currentCommand }) => /^(?:n?vim)$/i.test(currentCommand));
}

function nvimPid(tree: ProcInfo[], fallback: number): number {
  return tree.find(({ command }) => /(?:^|\/)(?:n?vim)(?:\s|$)/i.test(command))?.pid ?? fallback;
}

async function waitForExit(
  process: ProcessPort,
  pid: number,
  graceMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  let alive = await process.isAlive(pid);
  let elapsed = 0;
  const grace = Math.max(0, graceMs);

  while (alive && elapsed < grace) {
    const delay = Math.min(100, grace - elapsed);
    await sleep(delay);
    elapsed += delay;
    alive = await process.isAlive(pid);
  }

  return !alive;
}

export function createSessionService({
  tmux,
  process,
  config,
  state,
  worktrees,
  clock,
  logger,
  sleep = defaultSleep,
  remoteHosts,
}: SessionServiceDependencies): SessionService {
  // Clock is part of the stable service dependency contract; touch owns the timestamp update.
  void clock;

  const requireRemoteHosts = (hostId: string): RemoteHostService => {
    if (!remoteHosts) {
      throw new SwarmError("unsupported", `Remote host service is unavailable: ${hostId}`);
    }
    return remoteHosts;
  };

  const mountedSessionName = (worktree: Worktree): string => {
    const hostId = worktreeHost(worktree);
    return hostId === "local" ? worktree.session : proxySessionName(hostId, worktree.session);
  };

  const mountRemote = async (worktree: Worktree, hostId: string): Promise<void> => {
    const cfg = await attempt(() => config.load(), "fs", "Failed to load session config");
    const host = cfg.hosts[hostId];
    if (!host) throw new SwarmError("not-found", `Remote host not found: ${hostId}`);
    const proxy = proxySessionName(hostId, worktree.session);
    const exists = await attempt(
      () => tmux.hasSession(proxy),
      "tmux",
      `Failed to inspect tmux session ${proxy}`,
    );
    if (exists) return;
    await attempt(
      () =>
        tmux.newSession({
          name: proxy,
          windowName: "ssh",
          command: sshInteractiveCommand({ id: hostId, ...host }, worktree.id),
        }),
      "tmux",
      `Failed to create tmux session ${proxy}`,
    );
  };

  const mount = async (worktree: Worktree): Promise<void> => {
    const hostId = worktreeHost(worktree);
    if (hostId !== "local") return mountRemote(worktree, hostId);

    const cfg = await attempt(() => config.load(), "fs", "Failed to load session config");
    const windowSpecs = resolveWindows(cfg);
    const firstSpec = windowSpecs[0];
    if (!firstSpec) {
      throw new SwarmError("validation", "At least one configured window is required");
    }

    const exists = await attempt(
      () => tmux.hasSession(worktree.session),
      "tmux",
      `Failed to inspect tmux session ${worktree.session}`,
    );
    let windows: TmuxWindow[];
    let mutated = false;

    if (!exists) {
      await attempt(
        () =>
          tmux.newSession({
            name: worktree.session,
            cwd: worktree.path,
            windowName: firstSpec.name,
          }),
        "tmux",
        `Failed to create tmux session ${worktree.session}`,
      );
      mutated = true;
      windows = await attempt(
        () => tmux.listWindows(worktree.session),
        "tmux",
        `Failed to list windows for ${worktree.session}`,
      );
      const firstIndex = Math.min(...windows.map(({ index }) => index));
      await attempt(
        () =>
          tmux.sendKeys(`=${worktree.session}:${firstIndex}`, [firstSpec.command], { enter: true }),
        "tmux",
        `Failed to start ${firstSpec.command}`,
      );
    } else {
      windows = await attempt(
        () => tmux.listWindows(worktree.session),
        "tmux",
        `Failed to list windows for ${worktree.session}`,
      );
    }

    const existingNames = new Set(windows.map(({ name }) => name));
    const specsToCreate = exists
      ? windowSpecs.filter(({ name }) => !existingNames.has(name))
      : windowSpecs.slice(1);

    for (const spec of specsToCreate) {
      const index = await attempt(
        () => tmux.newWindow({ session: worktree.session, name: spec.name, cwd: worktree.path }),
        "tmux",
        `Failed to create tmux window ${spec.name}`,
      );
      await attempt(
        () => tmux.sendKeys(`=${worktree.session}:${index}`, [spec.command], { enter: true }),
        "tmux",
        `Failed to start ${spec.command}`,
      );
      mutated = true;
    }

    if (mutated && (exists || specsToCreate.length > 0)) {
      windows = await attempt(
        () => tmux.listWindows(worktree.session),
        "tmux",
        `Failed to refresh windows for ${worktree.session}`,
      );
    }

    const baseIndex = Math.min(...windows.map(({ index }) => index));
    for (const [position, spec] of windowSpecs.entries()) {
      const ordered = [...windows].sort((left, right) => left.index - right.index);
      const window = windows.find(({ name }) => name === spec.name);
      const target = ordered[position];
      if (!window || !target || window.index === target.index) continue;
      await attempt(
        () => tmux.swapWindows(worktree.session, window.index, target.index),
        "tmux",
        `Failed to reorder tmux window ${spec.name}`,
      );
      mutated = true;
      windows = await attempt(
        () => tmux.listWindows(worktree.session),
        "tmux",
        `Failed to refresh windows for ${worktree.session}`,
      );
    }

    const firstWindow = windows.find(({ index }) => index === baseIndex);
    if (firstWindow && (mutated || !firstWindow.active)) {
      await attempt(
        () => tmux.selectWindow(worktree.session, baseIndex),
        "tmux",
        `Failed to select the first window in ${worktree.session}`,
      );
    }
  };

  const unmount = async (worktree: Worktree): Promise<UnmountReport> => {
    const hostId = worktreeHost(worktree);
    if (hostId !== "local") {
      return requireRemoteHosts(hostId).sleep(hostId, worktree.session);
    }

    const exists = await attempt(
      () => tmux.hasSession(worktree.session),
      "tmux",
      `Failed to inspect tmux session ${worktree.session}`,
    );
    if (!exists) return { kept: [], closed: [], sessionKilled: false };

    const cfg = await attempt(() => config.load(), "fs", "Failed to load sleep policy");
    const windows = await attempt(
      () => tmux.listWindows(worktree.session),
      "tmux",
      `Failed to list windows for ${worktree.session}`,
    );

    if (!cfg.sleep.enabled) {
      return {
        kept: windows.map(({ name }) => ({ window: name, reason: "sleep disabled" })),
        closed: [],
        sessionKilled: false,
      };
    }

    const snapshot = await attempt(
      () => process.snapshot(),
      "unsupported",
      "Failed to inspect running processes",
    );
    const trees = new Map<TmuxWindow, ProcInfo[]>();
    for (const window of windows) {
      trees.set(
        window,
        uniqueProcesses(window.panes.flatMap((pane) => process.descendants(pane.pid, snapshot))),
      );
    }

    const descendantPids = [
      ...new Set([...trees.values()].flatMap((tree) => tree.map(({ pid }) => pid))),
    ];
    const ports =
      descendantPids.length === 0
        ? new Map<number, number[]>()
        : await attempt(
            () => process.listeningPorts(descendantPids),
            "unsupported",
            "Failed to inspect listening ports",
          );
    const rules = enabledValidRules(cfg.sleep.keepAlive, logger);
    const matched = new Map(
      windows.map((window) => [window, matchKeepAlive(rules, trees.get(window) ?? [], ports)]),
    );
    const kept: UnmountReport["kept"] = [];
    const closed: string[] = [];
    const closable: TmuxWindow[] = [];

    for (const window of [...windows].sort((left, right) => right.index - left.index)) {
      const labels = matched.get(window) ?? [];
      if (labels.length > 0) {
        kept.unshift({ window: window.name, reason: labels.join(", ") });
        continue;
      }

      const editorPanes = nvimPanes(window);
      if (editorPanes.length > 0) {
        for (const pane of editorPanes) {
          await attempt(
            () => tmux.sendKeys(pane.id, ["Escape", ":qa"], { enter: true }),
            "tmux",
            `Failed to close editor window ${window.name}`,
          );
        }
        const exited = await Promise.all(
          editorPanes.map((pane) => {
            const paneTree = process.descendants(pane.pid, snapshot);
            const editorPid = nvimPid(paneTree, pane.pid);
            return attempt(
              () => waitForExit(process, editorPid, cfg.sleep.graceMs, sleep),
              "unsupported",
              `Failed while waiting for editor window ${window.name}`,
            );
          }),
        );
        if (exited.some((value) => !value)) {
          kept.unshift({ window: window.name, reason: "unsaved changes" });
          continue;
        }
        closed.push(window.name);
        closable.push(window);
        continue;
      }

      closed.push(window.name);
      closable.push(window);
    }

    const sessionKilled = kept.length === 0;
    if (sessionKilled) {
      await attempt(
        () => tmux.killSession(worktree.session),
        "tmux",
        `Failed to kill empty tmux session ${worktree.session}`,
      );
    } else {
      for (const window of closable) {
        await attempt(
          () => tmux.killWindow(worktree.session, window.index),
          "tmux",
          `Failed to close tmux window ${window.name}`,
        );
      }
    }

    return { kept, closed, sessionKilled };
  };

  const open = async (
    worktree: Worktree,
    options: { sleepPrevious?: boolean } = {},
  ): Promise<void> => {
    const previous = await attempt(
      () => tmux.currentSession(),
      "tmux",
      "Failed to determine the current tmux session",
    );
    await mount(worktree);
    await attempt(
      () => worktrees.touch(worktree.id),
      "fs",
      `Failed to update last-opened time for ${worktree.id}`,
    );

    const targetSession = mountedSessionName(worktree);
    try {
      if (tmux.insideTmux()) {
        await tmux.switchClient(targetSession);
      } else {
        await tmux.attach(targetSession);
      }
    } catch (error) {
      throw serviceError(error, "tmux", `Failed to open tmux session ${targetSession}`);
    }

    if ((options.sleepPrevious ?? true) && previous && previous !== targetSession) {
      try {
        const currentState = await state.load();
        const previousWorktree = currentState.worktrees.find(
          (candidate) => mountedSessionName(candidate) === previous,
        );
        if (previousWorktree) await unmount(previousWorktree);
      } catch (error) {
        logger.warn("Failed to sleep previous worktree session", {
          session: previous,
          error,
        });
      }
    }
  };

  const kill = async (worktree: Worktree): Promise<void> => {
    const hostId = worktreeHost(worktree);
    if (hostId !== "local") {
      await requireRemoteHosts(hostId).kill(hostId, worktree.id);
      const proxy = proxySessionName(hostId, worktree.session);
      const proxyExists = await attempt(
        () => tmux.hasSession(proxy),
        "tmux",
        `Failed to inspect tmux session ${proxy}`,
      );
      if (proxyExists) {
        await attempt(
          () => tmux.killSession(proxy),
          "tmux",
          `Failed to kill tmux session ${proxy}`,
        );
      }
      return;
    }

    const exists = await attempt(
      () => tmux.hasSession(worktree.session),
      "tmux",
      `Failed to inspect tmux session ${worktree.session}`,
    );
    if (!exists) return;
    await attempt(
      () => tmux.killSession(worktree.session),
      "tmux",
      `Failed to kill tmux session ${worktree.session}`,
    );
  };

  return { mount, open, unmount, kill };
}
