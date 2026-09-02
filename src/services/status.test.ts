import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TmuxPane, TmuxSession, TmuxWindow } from "../core/ports.ts";
import { createFakeProcess } from "../testing/fakeProcess.ts";
import { createFakeTmux } from "../testing/fakeTmux.ts";
import { config, worktrees } from "../testing/fixtures.ts";
import { createMemoryConfig } from "../testing/memoryConfig.ts";
import { createNullLogger } from "../testing/nullLogger.ts";
import { createStatusService } from "./status.ts";

function session(name: string, attached: boolean): TmuxSession {
  return { name, attached, windows: 1, createdAt: 1, lastActivityAt: 1 };
}

function pane(id: string, pid: number, currentCommand: string): TmuxPane {
  return { id, pid, currentCommand, currentPath: "/tmp" };
}

function window(sessionName: string, index: number, name: string, panes: TmuxPane[]): TmuxWindow {
  return { session: sessionName, index, name, active: index === 0, panes };
}

describe("StatusService.snapshot", () => {
  test("reports attached, detached, and absent sessions with keep-alive labels", async () => {
    const [attachedWorktree, detachedWorktree, absentWorktree] = worktrees;
    assert.ok(attachedWorktree && detachedWorktree && absentWorktree);
    const tmux = createFakeTmux({
      sessions: [session(attachedWorktree.session, true), session(detachedWorktree.session, false)],
      windows: [
        window(attachedWorktree.session, 0, "cc", [pane("%1", 10, "zsh")]),
        window(attachedWorktree.session, 1, "server", [pane("%2", 20, "zsh")]),
        window(detachedWorktree.session, 0, "lg", [pane("%3", 30, "lazygit")]),
        window("unrelated/session", 0, "other", [pane("%4", 40, "node")]),
      ],
    });
    const process = createFakeProcess(
      [
        { pid: 10, ppid: 1, command: "zsh" },
        { pid: 11, ppid: 10, command: "/opt/bin/claude --resume" },
        { pid: 20, ppid: 1, command: "zsh" },
        { pid: 21, ppid: 20, command: "node server.js" },
        { pid: 30, ppid: 1, command: "lazygit" },
        { pid: 40, ppid: 1, command: "node unrelated.js" },
      ],
      new Map([
        [21, [3000]],
        [40, [9999]],
      ]),
    );
    const service = createStatusService({
      tmux,
      process,
      config: createMemoryConfig(config),
      logger: createNullLogger(),
    });

    const statuses = await service.snapshot([attachedWorktree, detachedWorktree, absentWorktree]);

    assert.equal(statuses.get(attachedWorktree.id)?.session, "attached");
    assert.equal(statuses.get(detachedWorktree.id)?.session, "detached");
    assert.equal(statuses.get(absentWorktree.id)?.session, "none");
    assert.deepEqual(statuses.get(attachedWorktree.id)?.windows, [
      { index: 0, name: "cc", command: "zsh", keepAlive: ["claude"] },
      { index: 1, name: "server", command: "zsh", keepAlive: [":3000"] },
    ]);
    assert.deepEqual(statuses.get(attachedWorktree.id)?.running, ["claude", ":3000"]);
    assert.deepEqual(statuses.get(absentWorktree.id)?.windows, []);
    assert.equal(tmux.calls.filter(({ method }) => method === "listSessions").length, 1);
    assert.equal(tmux.calls.filter(({ method }) => method === "listWindows").length, 1);
    assert.equal(process.snapshotCalls, 1);
    assert.equal(process.listeningPortCalls, 1);
  });

  test("returns none for every worktree and logs when tmux fails", async () => {
    const selected = worktrees.slice(0, 3);
    const tmux = createFakeTmux();
    tmux.listSessions = async () => {
      throw new Error("tmux server unavailable");
    };
    const logger = createNullLogger();
    const service = createStatusService({
      tmux,
      process: createFakeProcess(),
      config: createMemoryConfig(config),
      logger,
    });

    const statuses = await service.snapshot(selected);

    assert.equal(statuses.size, selected.length);
    for (const worktree of selected) {
      assert.deepEqual(statuses.get(worktree.id), {
        worktreeId: worktree.id,
        session: "none",
        windows: [],
        running: [],
      });
    }
    assert.equal(logger.entries.at(-1)?.level, "error");
  });

  test("skips the port scan when swarm sessions have no descendant pids", async () => {
    const selected = worktrees.slice(0, 1);
    const process = createFakeProcess();
    const service = createStatusService({
      tmux: createFakeTmux(),
      process,
      config: createMemoryConfig(config),
      logger: createNullLogger(),
    });

    await service.snapshot(selected);

    assert.equal(process.listeningPortCalls, 0);
  });

  test("preserves tmux state when process enrichment fails", async () => {
    const target = worktrees[0];
    assert.ok(target);
    const tmux = createFakeTmux({
      sessions: [session(target.session, true)],
      windows: [window(target.session, 0, "cc", [pane("%1", 10, "zsh")])],
    });
    const process = createFakeProcess();
    process.snapshot = async () => {
      throw new Error("ps unavailable");
    };
    const service = createStatusService({
      tmux,
      process,
      config: createMemoryConfig(config),
      logger: createNullLogger(),
    });

    const status = (await service.snapshot([target])).get(target.id);
    assert.equal(status?.session, "attached");
    assert.deepEqual(status?.windows, [{ index: 0, name: "cc", command: "zsh", keepAlive: [] }]);
  });

  test("preserves process labels when listening-port enrichment fails", async () => {
    const target = worktrees[0];
    assert.ok(target);
    const tmux = createFakeTmux({
      sessions: [session(target.session, false)],
      windows: [window(target.session, 0, "cc", [pane("%1", 10, "zsh")])],
    });
    const process = createFakeProcess([
      { pid: 10, ppid: 1, command: "zsh" },
      { pid: 11, ppid: 10, command: "/opt/bin/claude --resume" },
    ]);
    process.listeningPorts = async () => {
      throw new Error("lsof unavailable");
    };
    const service = createStatusService({
      tmux,
      process,
      config: createMemoryConfig(config),
      logger: createNullLogger(),
    });

    const status = (await service.snapshot([target])).get(target.id);
    assert.equal(status?.session, "detached");
    assert.deepEqual(status?.running, ["claude"]);
  });
});
