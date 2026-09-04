import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TmuxPane, TmuxSession, TmuxWindow } from "../core/ports.ts";
import { sshInteractiveCommand, sshPaneCommand } from "../core/remote.ts";
import type { RemoteHostService, WorktreeService } from "../core/services.ts";
import type { Config, Worktree } from "../core/types.ts";
import { createFakeProcess } from "../testing/fakeProcess.ts";
import { createFakeTmux, type FakeTmux } from "../testing/fakeTmux.ts";
import { createFixedClock } from "../testing/fixedClock.ts";
import { config as defaultFixtureConfig, makeState, worktrees } from "../testing/fixtures.ts";
import { createMemoryConfig } from "../testing/memoryConfig.ts";
import { createMemoryState } from "../testing/memoryState.ts";
import { createNullLogger } from "../testing/nullLogger.ts";
import { createSessionService } from "./sessions.ts";

const target = worktrees[0] as Worktree;
const previous = worktrees[1] as Worktree;

function session(name: string, attached = false, windows = 0): TmuxSession {
  return { name, attached, windows, createdAt: 1, lastActivityAt: 1 };
}

function pane(
  id: string,
  pid: number,
  currentCommand: string,
  currentPath = target.path,
): TmuxPane {
  return { id, pid, currentCommand, currentPath };
}

function window(
  sessionName: string,
  index: number,
  name: string,
  panes: TmuxPane[] = [],
  active = index === 0,
): TmuxWindow {
  return { session: sessionName, index, name, active, panes };
}

function configured(overrides: Partial<Config> = {}): Config {
  return structuredClone({ ...defaultFixtureConfig, ...overrides });
}

function fakeWorktreeService(): WorktreeService & { touches: string[] } {
  const touches: string[] = [];
  return {
    touches,
    async reconcileCreating() {},
    async coordinateRepoDeletion(_repoId, action) {
      await action();
    },
    async list() {
      return [];
    },
    async remoteBranches() {
      return [];
    },
    async prepareHotCopy() {},
    async refreshPreparedCopy() {},
    async awaitPendingRefresh() {},
    async runPostCreateHooks() {},
    async create() {
      return target;
    },
    async delete() {},
    async touch(id) {
      touches.push(id);
    },
  };
}

function serviceOptions(
  tmux: FakeTmux,
  options: {
    process?: ReturnType<typeof createFakeProcess>;
    config?: Config;
    state?: ReturnType<typeof makeState>;
    worktreeService?: ReturnType<typeof fakeWorktreeService>;
    sleep?: (ms: number) => Promise<void>;
    remoteHosts?: RemoteHostService;
  } = {},
) {
  const process = options.process ?? createFakeProcess();
  const worktreeService = options.worktreeService ?? fakeWorktreeService();
  const logger = createNullLogger();
  return {
    service: createSessionService({
      tmux,
      process,
      config: createMemoryConfig(options.config ?? configured()),
      state: createMemoryState(options.state ?? makeState()),
      worktrees: worktreeService,
      clock: createFixedClock(),
      logger,
      home: "/home/test/.swarm",
      sleep: options.sleep,
      remoteHosts: options.remoteHosts,
    }),
    process,
    worktreeService,
    logger,
  };
}

function fakeRemoteHostService(): RemoteHostService & {
  calls: Array<{ method: string; hostId: string; target: string }>;
} {
  const calls: Array<{ method: string; hostId: string; target: string }> = [];
  return {
    calls,
    async list() {
      return { protocol: 1, version: "swarm test", repos: [], worktrees: [] };
    },
    async create() {
      return { created: true, worktree: target };
    },
    async delete() {
      return { ok: true };
    },
    async kill(hostId, worktreeId) {
      calls.push({ method: "kill", hostId, target: worktreeId });
    },
    async sleep(hostId, sessionName) {
      calls.push({ method: "sleep", hostId, target: sessionName });
      return {
        kept: [{ window: "cc", reason: "claude" }],
        closed: ["nvim"],
        sessionKilled: false,
      };
    },
    async status() {
      return [];
    },
    async inspect() {
      return [];
    },
    async sync() {
      return [];
    },
    async syncAll() {
      return [];
    },
    async remoteSnapshot() {
      return new Map();
    },
    lastError() {
      return undefined;
    },
  };
}

describe("SessionService.mount", () => {
  test("creates configured windows in order and starts their commands", async () => {
    const tmux = createFakeTmux();
    const { service } = serviceOptions(tmux);

    await service.mount(target);

    assert.deepEqual(
      (tmux.windows.get(target.session) ?? [])
        .sort((left, right) => left.index - right.index)
        .map(({ index, name }) => [index, name]),
      [
        [0, "nvim"],
        [1, "cc"],
        [2, "lg"],
      ],
    );
    assert.deepEqual(tmux.sentKeys, [
      { target: `=${target.session}:0`, keys: ["nvim ."], enter: true },
      { target: `=${target.session}:1`, keys: ["claude"], enter: true },
      { target: `=${target.session}:2`, keys: ["lazygit"], enter: true },
    ]);
    assert.equal(tmux.calls.at(-1)?.method, "selectWindow");
  });

  test("starts the selected agent in the stable cc window", async () => {
    const tmux = createFakeTmux();
    const { service } = serviceOptions(tmux, {
      config: configured({
        agent: "opencode",
        agentCommands: { claude: "claude", opencode: "opencode --model sonnet" },
      }),
    });

    await service.mount(target);

    assert.deepEqual(tmux.sentKeys[1], {
      target: `=${target.session}:1`,
      keys: ["opencode --model sonnet"],
      enter: true,
    });
  });

  test("repairs and reorders a partial session from its lowest index", async () => {
    const tmux = createFakeTmux({
      sessions: [session(target.session, false, 1)],
      windows: [window(target.session, 2, "cc", [], true)],
    });
    const { service } = serviceOptions(tmux);

    await service.mount(target);

    assert.deepEqual(
      (tmux.windows.get(target.session) ?? [])
        .sort((left, right) => left.index - right.index)
        .map(({ index, name }) => [index, name]),
      [
        [2, "nvim"],
        [3, "cc"],
        [4, "lg"],
      ],
    );
    assert.deepEqual(tmux.sentKeys, [
      { target: `=${target.session}:3`, keys: ["nvim ."], enter: true },
      { target: `=${target.session}:4`, keys: ["lazygit"], enter: true },
    ]);
  });

  test("does not mutate an already mounted session", async () => {
    const tmux = createFakeTmux({
      sessions: [session(target.session, true, 3)],
      windows: [
        window(target.session, 1, "nvim", [], true),
        window(target.session, 2, "cc", [], false),
        window(target.session, 3, "lg", [], false),
      ],
    });
    const { service } = serviceOptions(tmux);

    await service.mount(target);

    const mutationMethods = new Set([
      "newSession",
      "newWindow",
      "sendKeys",
      "swapWindows",
      "selectWindow",
    ]);
    assert.deepEqual(
      tmux.calls.filter(({ method }) => mutationMethods.has(method)),
      [],
    );
  });

  test("moves user-created windows after all configured windows", async () => {
    const tmux = createFakeTmux({
      sessions: [session(target.session, false, 2)],
      windows: [
        window(target.session, 0, "shell", [], true),
        window(target.session, 1, "cc", [], false),
      ],
    });
    const { service } = serviceOptions(tmux);

    await service.mount(target);

    assert.deepEqual(
      (tmux.windows.get(target.session) ?? [])
        .sort((left, right) => left.index - right.index)
        .map(({ name }) => name),
      ["nvim", "cc", "lg", "shell"],
    );
  });

  test("reorders configured windows across non-contiguous indices", async () => {
    const tmux = createFakeTmux({
      sessions: [session(target.session, false, 3)],
      windows: [
        window(target.session, 1, "nvim", [], true),
        window(target.session, 4, "lg", [], false),
        window(target.session, 8, "cc", [], false),
      ],
    });
    const { service } = serviceOptions(tmux);

    await service.mount(target);

    assert.deepEqual(
      (tmux.windows.get(target.session) ?? [])
        .sort((left, right) => left.index - right.index)
        .map(({ index, name }) => [index, name]),
      [
        [1, "nvim"],
        [4, "cc"],
        [8, "lg"],
      ],
    );
  });
});

describe("SessionService.mount cleanup", () => {
  test("kills a freshly created session when a later step fails", async () => {
    const tmux = createFakeTmux();
    tmux.newWindow = async (opts) => {
      tmux.calls.push({ method: "newWindow", args: [opts] });
      throw new Error("new-window exploded");
    };
    const { service } = serviceOptions(tmux);

    await assert.rejects(service.mount(target), /Failed to create tmux window cc/u);

    assert.equal(tmux.sessions.has(target.session), false);
    assert.deepEqual(
      tmux.calls
        .filter(({ method }) => method === "newSession" || method === "killSessionIfPresent")
        .map(({ method, args }) => [method, (args[0] as { name?: string }).name ?? args[0]]),
      [
        ["newSession", target.session],
        ["killSessionIfPresent", target.session],
      ],
    );
  });

  test("leaves an existing session alone when a later step fails", async () => {
    const tmux = createFakeTmux({
      sessions: [session(target.session, false, 1)],
      windows: [window(target.session, 0, "nvim", [], true)],
    });
    tmux.newWindow = async (opts) => {
      tmux.calls.push({ method: "newWindow", args: [opts] });
      throw new Error("new-window exploded");
    };
    const { service } = serviceOptions(tmux);

    await assert.rejects(service.mount(target), /Failed to create tmux window cc/u);

    assert.equal(tmux.sessions.has(target.session), true);
    assert.equal(
      tmux.calls.some(({ method }) => method === "killSessionIfPresent"),
      false,
    );
  });
});

describe("SessionService.open", () => {
  test("switches first, then sleeps the previous registered worktree", async () => {
    const tmux = createFakeTmux({
      insideTmux: true,
      currentSession: previous.session,
      sessions: [session(target.session, false, 3), session(previous.session, true, 1)],
      windows: [
        window(target.session, 0, "nvim", [], true),
        window(target.session, 1, "cc", [], false),
        window(target.session, 2, "lg", [], false),
        window(previous.session, 0, "lg", [], true),
      ],
    });
    const worktreeService = fakeWorktreeService();
    const { service } = serviceOptions(tmux, { worktreeService });

    await service.open(target);

    assert.deepEqual(worktreeService.touches, [target.id]);
    const methods = tmux.calls.map(({ method }) => method);
    assert.ok(methods.indexOf("switchClient") < methods.indexOf("killSession"));
    assert.equal(tmux.sessions.has(previous.session), false);
  });

  test("keeps the previous session when the opened session is gone after the switch", async () => {
    const tmux = createFakeTmux({
      insideTmux: true,
      currentSession: previous.session,
      sessions: [session(target.session, false, 3), session(previous.session, true, 1)],
      windows: [
        window(target.session, 0, "nvim", [], true),
        window(target.session, 1, "cc", [], false),
        window(target.session, 2, "lg", [], false),
        window(previous.session, 0, "lg", [], true),
      ],
    });
    const originalSwitchClient = tmux.switchClient;
    tmux.switchClient = async (sessionName) => {
      await originalSwitchClient(sessionName);
      // The target dies right after the switch, as a proxy whose ssh leg failed would.
      tmux.sessions.delete(sessionName);
      tmux.windows.delete(sessionName);
    };
    const { service, logger } = serviceOptions(tmux);

    await service.open(target);

    assert.deepEqual(tmux.switched, [target.session]);
    assert.equal(tmux.sessions.has(previous.session), true);
    assert.equal(
      tmux.calls.some(({ method }) => method === "killSession" || method === "killWindow"),
      false,
    );
    assert.equal(logger.entries.filter(({ level }) => level === "warn").length, 1);
  });

  test("logs a sleep failure without failing the open", async () => {
    const tmux = createFakeTmux({
      insideTmux: true,
      currentSession: previous.session,
      sessions: [session(target.session, false, 3), session(previous.session, true, 1)],
      windows: [
        window(target.session, 0, "nvim", [], true),
        window(target.session, 1, "cc", [], false),
        window(target.session, 2, "lg", [], false),
        window(previous.session, 0, "lg", [], true),
      ],
    });
    const originalListWindows = tmux.listWindows;
    tmux.listWindows = async (sessionName) => {
      if (sessionName === previous.session) throw new Error("previous session disappeared");
      return originalListWindows(sessionName);
    };
    const { service, logger } = serviceOptions(tmux);

    await service.open(target);

    assert.deepEqual(tmux.switched, [target.session]);
    assert.equal(logger.entries.at(-1)?.level, "warn");
  });
});

describe("SessionService.unmount", () => {
  test("is idempotent when the worktree has no tmux session", async () => {
    const { service, process } = serviceOptions(createFakeTmux());

    assert.deepEqual(await service.unmount(target), {
      kept: [],
      closed: [],
      sessionKilled: false,
    });
    assert.equal(process.snapshotCalls, 0);
  });

  test("keeps process and port matches while closing lazygit", async () => {
    const tmux = createFakeTmux({
      sessions: [session(target.session, false, 3)],
      windows: [
        window(target.session, 0, "cc", [pane("%1", 10, "zsh")]),
        window(target.session, 1, "server", [pane("%2", 20, "zsh")], false),
        window(target.session, 2, "lg", [pane("%3", 30, "lazygit")], false),
      ],
    });
    const process = createFakeProcess(
      [
        { pid: 10, ppid: 1, command: "zsh" },
        { pid: 11, ppid: 10, command: "/usr/local/bin/claude --resume" },
        { pid: 20, ppid: 1, command: "zsh" },
        { pid: 21, ppid: 20, command: "node server.js" },
        { pid: 30, ppid: 1, command: "lazygit" },
      ],
      new Map([[21, [3000]]]),
    );
    const { service } = serviceOptions(tmux, { process });

    const report = await service.unmount(target);

    assert.deepEqual(report, {
      kept: [
        { window: "cc", reason: "claude" },
        { window: "server", reason: ":3000" },
      ],
      closed: ["lg"],
      sessionKilled: false,
    });
    assert.equal(process.snapshotCalls, 1);
    assert.equal(process.listeningPortCalls, 1);
  });

  test("gracefully closes nvim and kills an empty session when its pid exits", async () => {
    const tmux = createFakeTmux({
      sessions: [session(target.session, false, 1)],
      windows: [window(target.session, 0, "nvim", [pane("%1", 10, "nvim")])],
    });
    const process = createFakeProcess([
      { pid: 10, ppid: 1, command: "zsh" },
      { pid: 11, ppid: 10, command: "/usr/local/bin/nvim README.md" },
    ]);
    const { service } = serviceOptions(tmux, {
      process,
      sleep: async () => {
        process.alive.delete(11);
      },
    });

    const report = await service.unmount(target);

    assert.deepEqual(report, { kept: [], closed: ["nvim"], sessionKilled: true });
    assert.deepEqual(tmux.sentKeys, [{ target: "%1", keys: ["Escape", ":qa"], enter: true }]);
    assert.equal(
      tmux.calls.some(({ method }) => method === "killWindow"),
      false,
    );
    assert.equal(tmux.sessions.has(target.session), false);
  });

  test("keeps nvim when it remains alive through the grace period", async () => {
    const tmux = createFakeTmux({
      sessions: [session(target.session, false, 1)],
      windows: [window(target.session, 0, "nvim", [pane("%1", 10, "nvim")])],
    });
    const process = createFakeProcess([{ pid: 10, ppid: 1, command: "nvim" }]);
    const delays: number[] = [];
    const cfg = configured({
      sleep: { ...defaultFixtureConfig.sleep, graceMs: 200 },
    });
    const { service } = serviceOptions(tmux, {
      process,
      config: cfg,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    const report = await service.unmount(target);

    assert.deepEqual(report, {
      kept: [{ window: "nvim", reason: "unsaved changes" }],
      closed: [],
      sessionKilled: false,
    });
    assert.deepEqual(delays, [100, 100]);
  });

  test("kills an exited editor window while preserving an agent window", async () => {
    const tmux = createFakeTmux({
      sessions: [session(target.session, false, 2)],
      windows: [
        window(target.session, 0, "nvim", [pane("%1", 10, "nvim")]),
        window(target.session, 1, "cc", [pane("%2", 20, "zsh")], false),
      ],
    });
    const process = createFakeProcess([
      { pid: 10, ppid: 1, command: "nvim README.md" },
      { pid: 20, ppid: 1, command: "zsh" },
      { pid: 21, ppid: 20, command: "/opt/bin/claude --resume" },
    ]);
    const { service } = serviceOptions(tmux, {
      process,
      sleep: async () => {
        process.alive.delete(10);
      },
    });

    assert.deepEqual(await service.unmount(target), {
      kept: [{ window: "cc", reason: "claude" }],
      closed: ["nvim"],
      sessionKilled: false,
    });
    assert.deepEqual(
      tmux.calls.filter(({ method }) => method === "killWindow").map(({ args }) => args[1]),
      [0],
    );
    assert.equal(tmux.sessions.has(target.session), true);
  });

  test("sends quit to every nvim pane before closing its session", async () => {
    const tmux = createFakeTmux({
      sessions: [session(target.session, false, 1)],
      windows: [
        window(target.session, 0, "editors", [pane("%1", 10, "nvim"), pane("%2", 20, "vim")]),
      ],
    });
    const process = createFakeProcess([
      { pid: 10, ppid: 1, command: "nvim one" },
      { pid: 20, ppid: 1, command: "vim two" },
    ]);
    const { service } = serviceOptions(tmux, {
      process,
      sleep: async () => {
        process.alive.delete(10);
        process.alive.delete(20);
      },
    });

    assert.deepEqual(await service.unmount(target), {
      kept: [],
      closed: ["editors"],
      sessionKilled: true,
    });
    assert.deepEqual(
      tmux.sentKeys.map(({ target }) => target),
      ["%1", "%2"],
    );
  });

  test("kills the session directly when every window can close", async () => {
    const tmux = createFakeTmux({
      sessions: [session(target.session, false, 2)],
      windows: [
        window(target.session, 4, "shell", [], true),
        window(target.session, 7, "lg", [], false),
      ],
    });
    const { service } = serviceOptions(tmux);

    const report = await service.unmount(target);

    assert.deepEqual(report, { kept: [], closed: ["lg", "shell"], sessionKilled: true });
    assert.deepEqual(
      tmux.calls.filter(({ method }) => method === "killWindow"),
      [],
    );
    assert.equal(tmux.calls.filter(({ method }) => method === "killSession").length, 1);
  });

  test("keeps every window without process inspection when sleep is disabled", async () => {
    const tmux = createFakeTmux({
      sessions: [session(target.session, false, 2)],
      windows: [window(target.session, 0, "nvim"), window(target.session, 1, "lg", [], false)],
    });
    const process = createFakeProcess();
    const cfg = configured({ sleep: { ...defaultFixtureConfig.sleep, enabled: false } });
    const { service } = serviceOptions(tmux, { process, config: cfg });

    const report = await service.unmount(target);

    assert.deepEqual(report, {
      kept: [
        { window: "nvim", reason: "sleep disabled" },
        { window: "lg", reason: "sleep disabled" },
      ],
      closed: [],
      sessionKilled: false,
    });
    assert.equal(process.snapshotCalls, 0);
  });

  test("warns and skips an invalid process regex", async () => {
    const tmux = createFakeTmux({
      sessions: [session(target.session, false, 1)],
      windows: [window(target.session, 0, "shell", [pane("%1", 10, "zsh")])],
    });
    const cfg = configured({
      sleep: {
        ...defaultFixtureConfig.sleep,
        keepAlive: [{ id: "bad", label: "bad", kind: "process", pattern: "[", enabled: true }],
      },
    });
    const { service, logger } = serviceOptions(tmux, {
      config: cfg,
      process: createFakeProcess([{ pid: 10, ppid: 1, command: "zsh" }]),
    });

    await service.unmount(target);

    assert.equal(logger.entries.filter(({ level }) => level === "warn").length, 1);
  });
});

describe("SessionService remote routing", () => {
  const remote: Worktree = {
    ...target,
    host: "devbox",
    path: "/srv/swarm/worktrees/bukhr/payroll/main",
  };

  test("mount creates one command-backed ssh proxy window and open reuses it", async () => {
    const tmux = createFakeTmux();
    const remoteHosts = fakeRemoteHostService();
    const cfg = configured({
      hosts: { devbox: { ssh: "user@devbox", swarmCommand: "/opt/swarm" } },
    });
    const { service, worktreeService } = serviceOptions(tmux, {
      config: cfg,
      remoteHosts,
    });

    await service.mount(remote);
    await service.open(remote);

    const command = sshPaneCommand(
      sshInteractiveCommand(
        { id: "devbox", ssh: "user@devbox", swarmCommand: "/opt/swarm" },
        remote.id,
        "/home/test/.swarm",
      ),
    );
    assert.match(command, /^sh -c 'ssh -t -o /u);
    assert.match(command, /ControlPath=\/home\/test\/\.swarm\/cache\/ssh\/%C/u);
    assert.match(command, /-- user@devbox \/opt\/swarm open /u);
    assert.deepEqual(
      tmux.calls.filter(({ method }) => method === "newSession"),
      [
        {
          method: "newSession",
          args: [{ name: "devbox/payroll/main", windowName: "ssh", command }],
        },
      ],
    );
    assert.deepEqual(tmux.switched, ["devbox/payroll/main"]);
    assert.deepEqual(worktreeService.touches, [remote.id]);
    assert.equal(tmux.sentKeys.length, 0);
  });

  test("mount keeps the proxy pane and client alive when the ssh leg exits", async () => {
    const tmux = createFakeTmux();
    const { service } = serviceOptions(tmux, {
      config: configured({ hosts: { devbox: { ssh: "devbox", swarmCommand: "swarm" } } }),
      remoteHosts: fakeRemoteHostService(),
    });

    await service.mount(remote);

    const proxy = "devbox/payroll/main";
    assert.deepEqual(
      tmux.calls
        .filter(({ method }) => method === "newSession" || method === "setOption")
        .map(({ method, args }) => (method === "newSession" ? method : [method, ...args])),
      [
        "newSession",
        ["setOption", proxy, "remain-on-exit", "on"],
        ["setOption", proxy, "detach-on-destroy", "off"],
      ],
    );
    assert.deepEqual(
      [...(tmux.options.get(proxy) ?? [])],
      [
        ["remain-on-exit", "on"],
        ["detach-on-destroy", "off"],
      ],
    );
    // The wrapper does not change what tmux reports as the pane's command.
    assert.equal(tmux.windows.get(proxy)?.[0]?.panes[0]?.currentCommand, "ssh");
  });

  test("mount removes the proxy session when configuring it fails", async () => {
    const tmux = createFakeTmux();
    tmux.setOption = async (target, name, value) => {
      tmux.calls.push({ method: "setOption", args: [target, name, value] });
      throw new Error("set-option exploded");
    };
    const { service } = serviceOptions(tmux, {
      config: configured({ hosts: { devbox: { ssh: "devbox", swarmCommand: "swarm" } } }),
      remoteHosts: fakeRemoteHostService(),
    });

    await assert.rejects(
      service.mount(remote),
      /Failed to configure tmux session devbox\/payroll\/main/u,
    );

    assert.equal(tmux.sessions.has("devbox/payroll/main"), false);
    assert.deepEqual(
      tmux.calls
        .filter(({ method }) => method === "newSession" || method === "killSessionIfPresent")
        .map(({ method }) => method),
      ["newSession", "killSessionIfPresent"],
    );
  });

  test("mount reuses an existing proxy whose only pane is ssh", async () => {
    const proxy = "devbox/payroll/main";
    const tmux = createFakeTmux({
      sessions: [session(proxy, false, 1)],
      windows: [window(proxy, 0, "ssh", [pane("%1", 10, "ssh")])],
    });
    const { service } = serviceOptions(tmux, {
      config: configured({ hosts: { devbox: { ssh: "devbox", swarmCommand: "swarm" } } }),
      remoteHosts: fakeRemoteHostService(),
    });

    await service.mount(remote);

    assert.equal(tmux.calls.filter(({ method }) => method === "listWindows").length, 1);
    assert.equal(
      tmux.calls.some(({ method }) => method === "killSessionIfPresent"),
      false,
    );
    assert.equal(
      tmux.calls.some(({ method }) => method === "newSession"),
      false,
    );
  });

  test("mount replaces a restored proxy whose pane is not ssh", async () => {
    const proxy = "devbox/payroll/main";
    const tmux = createFakeTmux({
      sessions: [session(proxy, false, 1)],
      windows: [window(proxy, 0, "ssh", [pane("%1", 10, "zsh")])],
    });
    const { service } = serviceOptions(tmux, {
      config: configured({ hosts: { devbox: { ssh: "devbox", swarmCommand: "swarm" } } }),
      remoteHosts: fakeRemoteHostService(),
    });

    await service.mount(remote);

    assert.deepEqual(
      tmux.calls
        .filter(({ method }) => method === "killSessionIfPresent" || method === "newSession")
        .map(({ method }) => method),
      ["killSessionIfPresent", "newSession"],
    );
    assert.equal(tmux.windows.get(proxy)?.[0]?.panes[0]?.currentCommand, "ssh");
  });

  test("sleep delegates without touching the proxy, and kill delegates then removes it", async () => {
    const tmux = createFakeTmux({
      sessions: [session("devbox/payroll/main", false, 1)],
    });
    const remoteHosts = fakeRemoteHostService();
    const { service } = serviceOptions(tmux, {
      config: configured({
        hosts: { devbox: { ssh: "devbox", swarmCommand: "swarm" } },
      }),
      remoteHosts,
    });

    assert.deepEqual(await service.unmount(remote), {
      kept: [{ window: "cc", reason: "claude" }],
      closed: ["nvim"],
      sessionKilled: false,
    });
    assert.equal(tmux.sessions.has("devbox/payroll/main"), true);

    await service.kill(remote);

    assert.deepEqual(remoteHosts.calls, [
      { method: "sleep", hostId: "devbox", target: "payroll/main" },
      { method: "kill", hostId: "devbox", target: remote.id },
    ]);
    assert.equal(tmux.sessions.has("devbox/payroll/main"), false);
  });

  test("kill succeeds when the proxy vanishes after the remote command", async () => {
    const proxy = "devbox/payroll/main";
    const tmux = createFakeTmux({ sessions: [session(proxy, false, 1)] });
    const remoteHosts = fakeRemoteHostService();
    remoteHosts.kill = async (hostId, worktreeId) => {
      remoteHosts.calls.push({ method: "kill", hostId, target: worktreeId });
      tmux.sessions.delete(proxy);
    };
    const { service } = serviceOptions(tmux, {
      config: configured({ hosts: { devbox: { ssh: "devbox", swarmCommand: "swarm" } } }),
      remoteHosts,
    });

    await service.kill(remote);

    assert.deepEqual(remoteHosts.calls, [{ method: "kill", hostId: "devbox", target: remote.id }]);
    assert.ok(tmux.calls.some(({ method }) => method === "killSessionIfPresent"));
  });
});
