import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { createStore } from "../app/store.ts";
import type { Store, UiExit } from "../core/app.ts";
import type { PullRequest } from "../core/types.ts";
import { createFakeController, type FakeController } from "../testing/fakeController.ts";
import { config as fixtureConfig, makeAppState, pullRequest } from "../testing/fixtures.ts";
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

/** A PR whose head branch matches the `feat/payroll-fix` worktree fixture. */
const linkedPr = pullRequest({
  number: 1234,
  title: "feat: add pr integration to swarm",
  headRefName: "feat/payroll-fix",
  author: "dannyfuf",
  reviewDecision: "approved",
  updatedAt: "2026-09-02T10:00:00.000Z",
});

const loosePr = pullRequest({
  number: 1201,
  title: "fix: nil guard on payroll export",
  headRefName: "fix/nil-guard",
  author: "dannyfuf",
  updatedAt: "2026-09-01T10:00:00.000Z",
});

const reviewPr = pullRequest({
  repoId: "bukhr/platform",
  number: 877,
  title: "feat: payroll export v2",
  headRefName: "feat/export-v2",
  author: "jperez",
  updatedAt: "2026-09-02T08:00:00.000Z",
});

test("App paints a loading frame before startup data arrives", async () => {
  const store = createStore();
  const controller = createFakeController(store);
  const setup = await testRender(
    <App
      store={store}
      controller={controller}
      config={fixtureConfig}
      home="/home/test"
      onExit={() => undefined}
    />,
    { width: 80, height: 24 },
  );
  try {
    await setup.flush();
    assert.match(setup.captureCharFrame(), /Loading workspace/u);
  } finally {
    setup.renderer.destroy();
  }
});

function seedPrs(harness: Harness, tab: "mine" | "review", prs: PullRequest[]): void {
  const byRepo = new Map<string, PullRequest[]>();
  for (const pr of prs) byRepo.set(pr.repoId, [...(byRepo.get(pr.repoId) ?? []), pr]);
  for (const [repoId, group] of byRepo) {
    harness.store.dispatch({
      type: "prSlice",
      tab,
      repoId,
      slice: { prs: group, fetchedAt: "2026-09-02T11:58:00.000Z", loading: false },
    });
  }
}

async function mountWithPrs(): Promise<Harness> {
  const harness = await mount();
  seedPrs(harness, "mine", [linkedPr, loosePr]);
  seedPrs(harness, "review", [reviewPr]);
  await harness.setup.flush();
  return harness;
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

// The keymap dialog is 35 rows tall, so help tests mount a terminal that shows all of it.
const HELP_TERMINAL_HEIGHT = 40;

test("? opens the help dialog and a cancel key closes it", async () => {
  const harness = await mount(110, HELP_TERMINAL_HEIGHT);
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

test("p opens the pull request screen, Tab toggles the tab and q returns", async () => {
  const harness = await mountWithPrs();
  try {
    harness.setup.mockInput.pressKey("p");
    await harness.setup.flush();
    assert.equal(harness.store.getState().screen, "prs");
    const frame = harness.frame();
    assert.ok(frame.includes("PULL REQUESTS"), "the panes gave way to the PR body");
    assert.ok(!frame.includes("WORKTREES"));
    assert.ok(frame.includes("#1234"), "the PR number");
    assert.ok(frame.includes("feat: add pr integration to swarm"), "the PR title");
    assert.ok(frame.includes("approved"), "the state word");

    harness.setup.mockInput.pressTab();
    await harness.setup.flush();
    assert.equal(harness.store.getState().prTab, "review");
    assert.ok(harness.frame().includes("#877"));

    harness.setup.mockInput.pressKey("q");
    await harness.setup.flush();
    assert.equal(harness.store.getState().screen, "main");
    assert.deepEqual(harness.exits, [], "q on the PR screen goes back, it does not quit");
  } finally {
    harness.stop();
  }
});

test("the PR footer promises open or create worktree depending on the row", async () => {
  const harness = await mountWithPrs();
  try {
    harness.setup.mockInput.pressKey("p");
    await harness.setup.flush();
    assert.ok(harness.frame().includes("Enter open"), "the linked PR opens its worktree");

    harness.setup.mockInput.pressKey("j");
    await harness.setup.flush();
    assert.equal(harness.store.getState().prCursor, 1);
    assert.ok(harness.frame().includes("Enter create worktree"), "the loose PR creates one");
  } finally {
    harness.stop();
  }
});

test("opening a PR exits the popup once the controller resolves", async () => {
  const harness = await mountWithPrs();
  try {
    harness.setup.mockInput.pressKey("p");
    await harness.setup.flush();
    harness.setup.mockInput.pressEnter();
    await harness.setup.flush();
    assert.deepEqual(harness.exits, ["opened"]);
  } finally {
    harness.stop();
  }
});

test("y on the PR screen copies the PR url instead of a worktree path", async () => {
  const harness = await mountWithPrs();
  try {
    harness.setup.mockInput.pressKey("p");
    await harness.setup.flush();
    harness.setup.mockInput.pressKey("y");
    await harness.setup.flush();
    assert.deepEqual(harness.controller.yankedPrUrls, [linkedPr.url]);
    assert.deepEqual(harness.controller.yankedPaths, []);
  } finally {
    harness.stop();
  }
});

test("b opens the selected worktree PR without changing screens", async () => {
  const harness = await mountWithPrs();
  try {
    harness.store.dispatch({ type: "moveTo", pane: "worktrees", index: 2 });
    harness.setup.mockInput.pressKey("b");
    await harness.setup.flush();

    assert.equal(harness.store.getState().screen, "main");
    assert.deepEqual(harness.controller.browsedPrUrls, [linkedPr.url]);
  } finally {
    harness.stop();
  }
});

test("/ on the PR screen edits the PR filter, not the worktree filter", async () => {
  const harness = await mountWithPrs();
  try {
    harness.setup.mockInput.pressKey("p");
    await harness.setup.flush();
    harness.setup.mockInput.pressKey("/");
    await harness.setup.flush();
    await harness.setup.mockInput.typeText("guard");
    await harness.setup.flush();

    assert.equal(harness.store.getState().prFilter, "guard");
    assert.equal(harness.store.getState().filter, "");
    const frame = harness.frame();
    assert.ok(frame.includes("#1201"));
    assert.ok(!frame.includes("#1234"), "non matching rows are gone");
  } finally {
    harness.stop();
  }
});

test("the palette only lists commands the current screen can run", async () => {
  const main = await mountWithPrs();
  try {
    main.setup.mockInput.pressKey(":");
    await main.setup.flush();
    await main.setup.mockInput.typeText("clone");
    await main.setup.flush();
    assert.ok(main.frame().includes("Create or clone"));
  } finally {
    main.stop();
  }

  const prs = await mountWithPrs();
  try {
    prs.setup.mockInput.pressKey("p");
    await prs.setup.flush();
    prs.setup.mockInput.pressKey(":");
    await prs.setup.flush();
    await prs.setup.mockInput.typeText("clone");
    await prs.setup.flush();
    assert.ok(!prs.frame().includes("Create or clone"), "a main-only command is gone");

    for (let index = 0; index < 5; index += 1) prs.setup.mockInput.pressBackspace();
    await prs.setup.mockInput.typeText("browser");
    await prs.setup.flush();
    assert.ok(prs.frame().includes("Open in browser"), "a PR-only command shows up");
  } finally {
    prs.stop();
  }
});

test("the worktree list badges the branch that already has a pull request", async () => {
  const harness = await mountWithPrs();
  try {
    const frame = harness.frame();
    assert.ok(frame.includes("#1234 approved"), "the reverse link badge");
    assert.ok(frame.includes("1 to review"), "the review count in the top line");
  } finally {
    harness.stop();
  }
});

test("the help dialog documents the pull request keys", async () => {
  const harness = await mount(110, HELP_TERMINAL_HEIGHT);
  try {
    harness.setup.mockInput.pressKey("?");
    await harness.setup.flush();
    const frame = harness.frame();
    assert.ok(frame.includes("swarm 0.1.0+dev"));
    assert.ok(frame.includes("PULL REQUESTS"));
    assert.ok(frame.includes("Pull requests"), "p is listed in the normal section");
    assert.ok(frame.includes("Open PR in browser"));
    assert.ok(frame.includes("Back to worktrees"));
  } finally {
    harness.stop();
  }
});

test("the help dialog documents the tmux popup keys", async () => {
  const harness = await mount(110, HELP_TERMINAL_HEIGHT);
  try {
    harness.setup.mockInput.pressKey("?");
    await harness.setup.flush();
    const frame = harness.frame();
    assert.ok(frame.includes("TMUX (prefix is ctrl-s)"));
    assert.ok(frame.includes("Claude Code popup"), "prefix a opens Claude Code");
    assert.ok(frame.includes("OpenCode popup"), "prefix A opens OpenCode");
    assert.ok(frame.includes("Hide agent, keep running"), "ctrl-q hides the agent popup");
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
