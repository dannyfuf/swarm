/**
 * Standalone UI harness: renders the real TUI against the in-memory fakes so
 * the whole surface can be exercised (and screenshotted) without tmux, git or
 * GitHub.
 *
 *   node --experimental-ffi --import tsx src/ui/dev.tsx
 *
 * Env switches used by the capture script:
 *   SWARM_DEV_OP=1     start a never-ending operation (spinner rows + footer)
 *   SWARM_DEV_EMPTY=1  start with no contexts at all (empty states)
 */
import { createStore } from "../app/store.ts";
import type { WorktreeId, WorktreeStatus } from "../core/types.ts";
import { createFakeController } from "../testing/fakeController.ts";
import { makeState } from "../testing/fixtures.ts";
import { runTui } from "./runTui.tsx";

const HOME = "/home/test";

const statuses: Record<WorktreeId, WorktreeStatus> = {
  "bukhr/payroll#main": {
    worktreeId: "bukhr/payroll#main",
    session: "attached",
    windows: [
      { index: 0, name: "nvim", command: "nvim", keepAlive: [] },
      { index: 1, name: "cc", command: "claude", keepAlive: ["claude"] },
      { index: 2, name: "lg", command: "lazygit", keepAlive: [] },
    ],
    running: ["claude"],
  },
  "bukhr/payroll#feat-payroll-fix": {
    worktreeId: "bukhr/payroll#feat-payroll-fix",
    session: "detached",
    windows: [
      { index: 0, name: "nvim", command: "nvim", keepAlive: [] },
      { index: 1, name: "cc", command: "claude", keepAlive: ["claude"] },
      { index: 2, name: "web", command: "npm run dev", keepAlive: [":3000"] },
    ],
    running: ["claude", ":3000"],
  },
  "bukhr/payroll#fix-1234": {
    worktreeId: "bukhr/payroll#fix-1234",
    session: "none",
    windows: [],
    running: [],
  },
  "bukhr/platform#feat-api": {
    worktreeId: "bukhr/platform#feat-api",
    session: "detached",
    windows: [
      { index: 0, name: "nvim", command: "nvim", keepAlive: [] },
      { index: 1, name: "cx", command: "codex", keepAlive: ["codex"] },
    ],
    running: ["codex"],
  },
  "dannyfuf/dotfiles#main": {
    worktreeId: "dannyfuf/dotfiles#main",
    session: "none",
    windows: [],
    running: [],
  },
};

async function main(): Promise<void> {
  const empty = process.env.SWARM_DEV_EMPTY === "1";
  const store = createStore();
  const state = empty
    ? { version: 1 as const, contexts: [], repos: [], clones: [], worktrees: [] }
    : makeState();
  const controller = createFakeController(store, { state, operationDelayMs: 1500 });
  await controller.init();
  if (!empty) store.dispatch({ type: "statuses", statuses });

  if (process.env.SWARM_DEV_OP === "1") {
    store.dispatch({
      type: "opStart",
      op: {
        id: "dev-op",
        label: "Creating worktree",
        step: "Copying tree",
        log: ["Receiving objects: 84% (12480/14812)"],
        targetId: "bukhr/payroll#feat-payroll-fix",
        startedAt: Date.now(),
      },
    });
  }

  const exit = await runTui({
    store,
    controller,
    config: controller.getConfig(),
    home: HOME,
  });
  process.stdout.write(`swarm dev exit: ${exit}\n`);
  process.exit(0);
}

void main();
