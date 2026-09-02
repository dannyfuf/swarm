import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createStore } from "../app/store.ts";
import { afterFirstFrame, createStartupView, startInitialization } from "./runTui.tsx";

test("the lightweight startup view paints without loading the application", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 });
  try {
    setup.renderer.root.add(createStartupView(setup.renderer));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    assert.match(frame, /swarm/u);
    assert.match(frame, /Loading workspace/u);
  } finally {
    setup.renderer.destroy();
  }
});

test("initialization starts after the first frame and exposes deferred failures", async () => {
  const renderer = new EventEmitter();
  const store = createStore();
  const order: string[] = [];

  afterFirstFrame(
    renderer,
    {
      mark(name) {
        order.push(name);
      },
      measure(_name, operation) {
        return operation();
      },
    },
    () => {
      order.push("load");
      startInitialization(store, async () => {
        order.push("initialize");
        throw new Error("startup failed");
      });
    },
  );

  assert.deepEqual(order, []);
  renderer.emit("frame");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(order, ["ui.firstFrame", "load", "initialize"]);
  assert.equal(store.getState().error, "startup failed");
  assert.equal(store.getState().toasts.at(-1)?.text, "startup failed");
});
