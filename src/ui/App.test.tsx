import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { createStore } from "../app/store.ts";
import type { Store, UiExit } from "../core/app.ts";
import { createFakeController, type FakeController } from "../testing/fakeController.ts";
import { config as fixtureConfig, makeAppState } from "../testing/fixtures.ts";
import { App } from "./App.tsx";

interface Harness {
  setup: TestRendererSetup;
  store: Store;
  controller: FakeController;
  exits: UiExit[];
  frame: () => string;
  stop: () => void;
}

async function mount(width = 110, height = 32): Promise<Harness> {
  const store = createStore(makeAppState());
  const controller = createFakeController(store, { operationDelayMs: 0 });
  await controller.init();
  store.dispatch({
    type: "statuses",
    statuses: {
      "bukhr/payroll#main": {
        worktreeId: "bukhr/payroll#main",
        session: "attached",
        windows: [{ index: 1, name: "cc", command: "claude", keepAlive: ["claude"] }],
        running: ["claude"],
      },
    },
  });
  const exits: UiExit[] = [];
  const setup = await testRender(
    <App
      store={store}
      controller={controller}
      config={fixtureConfig}
      home="/home/test"
      onExit={(exit) => exits.push(exit)}
    />,
    { width, height },
  );
  await setup.flush();
  return {
    setup,
    store,
    controller,
    exits,
    frame: () => setup.captureCharFrame(),
    stop: () => setup.renderer.destroy(),
  };
}

test("runTui's App mounts and paints the full frame", async () => {
  const harness = await mount();
  try {
    const frame = harness.frame();
    assert.ok(frame.includes("swarm"), "title");
    assert.ok(frame.includes("REPOS"), "repos pane");
    assert.ok(frame.includes("WORKTREES"), "worktrees pane");
    assert.ok(frame.includes("payroll · main"), "a worktree row");
    assert.ok(frame.includes("claude"), "running label");
    const rows = frame.split("\n").filter((row) => row.length > 0);
    assert.equal(rows.length, 32);
    for (const row of rows) assert.equal(row.length, 110);
  } finally {
    harness.stop();
  }
});

test("j and k move the worktree cursor through the store", async () => {
  const harness = await mount();
  try {
    assert.equal(harness.store.getState().worktreeCursor, 0);
    harness.setup.mockInput.pressKey("j");
    await harness.setup.flush();
    assert.equal(harness.store.getState().worktreeCursor, 1);
    harness.setup.mockInput.pressKey("k");
    await harness.setup.flush();
    assert.equal(harness.store.getState().worktreeCursor, 0);
  } finally {
    harness.stop();
  }
});

test("h and l switch the focused pane", async () => {
  const harness = await mount();
  try {
    harness.setup.mockInput.pressKey("h");
    await harness.setup.flush();
    assert.equal(harness.store.getState().pane, "repos");
    harness.setup.mockInput.pressKey("l");
    await harness.setup.flush();
    assert.equal(harness.store.getState().pane, "worktrees");
  } finally {
    harness.stop();
  }
});

test("? opens the help dialog and a cancel key closes it", async () => {
  const harness = await mount();
  try {
    harness.setup.mockInput.pressKey("?");
    await harness.setup.flush();
    assert.equal(harness.store.getState().dialog?.kind, "help");
    assert.ok(harness.frame().includes("Keymap"));
    // A lone ESC byte stays buffered in the parser until more input arrives,
    // so drive the close through the dialog's other cancel key.
    harness.setup.mockInput.pressKey("q");
    await harness.setup.flush();
    assert.equal(harness.store.getState().dialog, undefined);
  } finally {
    harness.stop();
  }
});

test("settings shows the read-only clone protocol beside the config file note", async () => {
  const harness = await mount();
  try {
    harness.setup.mockInput.pressKey(",");
    await harness.setup.flush();
    const frame = harness.frame();
    assert.ok(frame.includes("clone protocol ssh"));
    assert.ok(frame.includes("edit in"));
    assert.ok(frame.includes("~/.swarm/config.json"));
  } finally {
    harness.stop();
  }
});

test("/ enters filter mode and typing narrows the list", async () => {
  const harness = await mount();
  try {
    harness.setup.mockInput.pressKey("/");
    await harness.setup.flush();
    assert.equal(harness.store.getState().mode, "filter");
    await harness.setup.mockInput.typeText("payroll-fix");
    await harness.setup.flush();
    assert.equal(harness.store.getState().filter, "payroll-fix");
    const frame = harness.frame();
    assert.ok(frame.includes("payroll-fix"));
    assert.ok(!frame.includes("fix/1234"), "non matching rows are gone");
  } finally {
    harness.stop();
  }
});

test("q asks the host to quit", async () => {
  const harness = await mount();
  try {
    harness.setup.mockInput.pressKey("q");
    await harness.setup.flush();
    assert.deepEqual(harness.exits, ["quit"]);
  } finally {
    harness.stop();
  }
});

test("q during an in-flight clone stays clean even if the clone promise rejects later", async () => {
  const harness = await mount();
  let stopped = false;
  let rejectClone: (error: Error) => void = () => undefined;
  harness.controller.cloneRepo = async () =>
    new Promise<void>((_resolve, reject) => {
      rejectClone = reject;
    });
  try {
    harness.setup.mockInput.pressKey("h");
    harness.setup.mockInput.pressKey("n");
    await harness.setup.flush();
    assert.equal(harness.store.getState().dialog?.kind, "clone-repo");

    harness.setup.mockInput.pressEnter();
    await harness.setup.flush();
    assert.equal(harness.store.getState().dialog, undefined);

    harness.setup.mockInput.pressKey("q");
    await harness.setup.flush();
    assert.deepEqual(harness.exits, ["quit"]);

    harness.stop();
    stopped = true;
    rejectClone(new Error("late clone failure"));
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    if (!stopped) harness.stop();
  }
});

test("ctrl-c asks the host to quit while a dialog is open", async () => {
  const harness = await mount();
  try {
    harness.setup.mockInput.pressKey("?");
    await harness.setup.flush();
    assert.equal(harness.store.getState().mode, "dialog");

    harness.setup.mockInput.pressKey("c", { ctrl: true });
    await harness.setup.flush();

    assert.deepEqual(harness.exits, ["quit"]);
  } finally {
    harness.stop();
  }
});

test("n opens the create-worktree dialog seeded with known base refs", async () => {
  const harness = await mount();
  try {
    harness.setup.mockInput.pressKey("n");
    await harness.setup.flush();
    const dialog = harness.store.getState().dialog;
    assert.equal(dialog?.kind, "create-worktree");
    if (dialog?.kind === "create-worktree") {
      assert.ok(dialog.branches.includes("origin/main"));
    }
    assert.ok(harness.frame().includes("New worktree"));
  } finally {
    harness.stop();
  }
});

test("submitting create-worktree closes the dialog immediately", async () => {
  const harness = await mount();
  try {
    harness.setup.mockInput.pressKey("n");
    await harness.setup.flush();
    await harness.setup.mockInput.typeText("feat/dialog-close");
    await harness.setup.flush();
    harness.setup.mockInput.pressEnter();
    await harness.setup.flush();

    assert.equal(harness.store.getState().dialog, undefined);
    assert.equal(harness.store.getState().mode, "normal");
  } finally {
    harness.stop();
  }
});
