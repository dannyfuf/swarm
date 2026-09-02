import assert from "node:assert/strict";
import { test } from "node:test";
import type { KeyEvent as CoreKeyEvent } from "@opentui/core";
import { resolveKey } from "../app/keymap.ts";
import { isEnter, isEscape, isListDown, isListUp, isSpace, isTab, toKeyEvent } from "./keys.ts";

function coreKey(overrides: Partial<CoreKeyEvent>): CoreKeyEvent {
  return {
    name: "",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: "",
    number: false,
    raw: "",
    eventType: "press",
    source: "raw",
    ...overrides,
  } as CoreKeyEvent;
}

test("toKeyEvent narrows the OpenTUI event to the keymap shape", () => {
  assert.deepEqual(toKeyEvent(coreKey({ name: "g", shift: true, sequence: "G" })), {
    name: "g",
    ctrl: false,
    shift: true,
    meta: false,
    sequence: "G",
  });
});

test("toKeyEvent tolerates a missing sequence", () => {
  assert.equal(toKeyEvent(coreKey({ name: "up", sequence: undefined as never })).sequence, "");
});

test("key predicates recognise the control keys", () => {
  assert.ok(isEscape(toKeyEvent(coreKey({ name: "escape" }))));
  assert.ok(isEnter(toKeyEvent(coreKey({ name: "return" }))));
  assert.ok(isTab(toKeyEvent(coreKey({ name: "tab" }))));
  assert.ok(isSpace(toKeyEvent(coreKey({ name: "space", sequence: " " }))));
});

test("j and k only move lists when no text field owns the keyboard", () => {
  const down = toKeyEvent(coreKey({ name: "j", sequence: "j" }));
  const up = toKeyEvent(coreKey({ name: "k", sequence: "k" }));
  assert.ok(isListDown(down, false));
  assert.ok(isListUp(up, false));
  assert.equal(isListDown(down, true), false);
  assert.equal(isListUp(up, true), false);
  assert.ok(isListDown(toKeyEvent(coreKey({ name: "n", ctrl: true })), true));
  assert.ok(isListUp(toKeyEvent(coreKey({ name: "p", ctrl: true })), true));
  assert.ok(isListDown(toKeyEvent(coreKey({ name: "down" })), true));
});

test("real OpenTUI key shapes resolve to the documented commands", () => {
  const context = { hasFilter: false, screen: "main" as const };
  const cases: Array<[Partial<CoreKeyEvent>, string]> = [
    [{ name: "j", sequence: "j" }, "down"],
    [{ name: "k", sequence: "k" }, "up"],
    [{ name: "g", sequence: "G", shift: true }, "bottom"],
    [{ name: "o", sequence: "O", shift: true }, "openKeep"],
    [{ name: "n", sequence: "N", shift: true }, "newContext"],
    [{ name: "k", sequence: "K", shift: true }, "kill"],
    [{ name: "d", ctrl: true, sequence: "" }, "halfDown"],
    [{ name: "u", ctrl: true, sequence: "" }, "halfUp"],
    [{ name: "/", sequence: "/" }, "filter"],
    [{ name: ":", sequence: ":" }, "palette"],
    [{ name: ",", sequence: "," }, "settings"],
    [{ name: "?", sequence: "?" }, "help"],
    [{ name: "tab" }, "right"],
    [{ name: "tab", shift: true }, "left"],
    [{ name: "1", sequence: "1", number: true }, "context:1"],
    [{ name: "return" }, "open"],
    [{ name: "q", sequence: "q" }, "quit"],
  ];
  for (const [raw, expected] of cases) {
    const resolved = resolveKey("normal", "", toKeyEvent(coreKey(raw)), context);
    assert.equal(resolved.command, expected, `key ${raw.name}/${raw.sequence ?? ""}`);
  }
});

test("gg and gt chord through the pending buffer", () => {
  const context = { hasFilter: false, screen: "main" as const };
  const first = resolveKey(
    "normal",
    "",
    toKeyEvent(coreKey({ name: "g", sequence: "g" })),
    context,
  );
  assert.equal(first.command, "none");
  assert.equal(first.pending, "g");
  assert.equal(
    resolveKey("normal", "g", toKeyEvent(coreKey({ name: "g", sequence: "g" })), context).command,
    "top",
  );
  assert.equal(
    resolveKey("normal", "g", toKeyEvent(coreKey({ name: "t", sequence: "t" })), context).command,
    "nextContext",
  );
  assert.equal(
    resolveKey(
      "normal",
      "g",
      toKeyEvent(coreKey({ name: "t", sequence: "T", shift: true })),
      context,
    ).command,
    "prevContext",
  );
});

test("filter mode leaves printable keys to the input", () => {
  const context = { hasFilter: true, screen: "main" as const };
  assert.equal(
    resolveKey("filter", "", toKeyEvent(coreKey({ name: "p", sequence: "p" })), context).command,
    "none",
  );
  assert.equal(
    resolveKey("filter", "", toKeyEvent(coreKey({ name: "return" })), context).command,
    "open",
  );
  // Esc is handled by the UI itself: it leaves the input but keeps the filter.
  assert.equal(
    resolveKey("filter", "", toKeyEvent(coreKey({ name: "escape" })), context).command,
    "none",
  );
});

test("dialog mode swallows everything except ctrl-c", () => {
  const context = { hasFilter: false, screen: "main" as const };
  assert.equal(
    resolveKey("dialog", "", toKeyEvent(coreKey({ name: "j", sequence: "j" })), context).command,
    "none",
  );
  assert.equal(
    resolveKey("dialog", "", toKeyEvent(coreKey({ name: "c", ctrl: true })), context).command,
    "quit",
  );
});
