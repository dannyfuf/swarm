import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Command, KeyEvent, Mode } from "../core/app.ts";
import { COMMANDS, KEY_HINTS, resolveKey } from "./keymap.ts";

function key(name: string, overrides: Partial<Omit<KeyEvent, "name">> = {}): KeyEvent {
  return { name, ctrl: false, shift: false, meta: false, sequence: name, ...overrides };
}

function resolve(
  mode: Mode,
  event: KeyEvent,
  pending = "",
  hasFilter = false,
  screen: "main" | "prs" = "main",
): { command: Command; pending: string } {
  return resolveKey(mode, pending, event, { hasFilter, screen });
}

describe("resolveKey normal mode", () => {
  const cases: Array<[string, KeyEvent, Command]> = [
    ["j", key("j"), "down"],
    ["down arrow", key("down"), "down"],
    ["k", key("k"), "up"],
    ["up arrow", key("up"), "up"],
    ["G", key("g", { shift: true }), "bottom"],
    ["ctrl-d", key("d", { ctrl: true }), "halfDown"],
    ["ctrl-u", key("u", { ctrl: true }), "halfUp"],
    ["h", key("h"), "left"],
    ["left arrow", key("left"), "left"],
    ["shift-tab", key("tab", { shift: true }), "left"],
    ["l", key("l"), "right"],
    ["right arrow", key("right"), "right"],
    ["tab", key("tab"), "right"],
    ["Enter", key("return"), "open"],
    ["o", key("o"), "open"],
    ["O", key("o", { shift: true }), "openKeep"],
    ["n", key("n"), "new"],
    ["N", key("n", { shift: true }), "newContext"],
    ["d", key("d"), "delete"],
    ["D", key("d", { shift: true }), "deleteContext"],
    ["s", key("s"), "sleep"],
    ["K", key("k", { shift: true }), "kill"],
    ["m", key("m"), "move"],
    ["r", key("r"), "refresh"],
    ["U", key("u", { shift: true }), "update"],
    ["/", key("/"), "filter"],
    [":", key(":"), "palette"],
    [",", key(","), "settings"],
    ["y", key("y"), "yank"],
    ["?", key("?"), "help"],
    ["q", key("q"), "quit"],
    ["Escape", key("escape"), "quit"],
    ["ctrl-c", key("c", { ctrl: true }), "quit"],
  ];

  for (const [label, event, command] of cases) {
    test(`${label} resolves to ${command}`, () => {
      assert.deepEqual(resolve("normal", event), { command, pending: "" });
    });
  }

  test("g starts a chord", () => {
    assert.deepEqual(resolve("normal", key("g")), { command: "none", pending: "g" });
  });

  const chords: Array<[string, KeyEvent, Command]> = [
    ["gg", key("g"), "top"],
    ["gt", key("t"), "nextContext"],
    ["gT", key("t", { shift: true }), "prevContext"],
    ["gT with uppercase name", key("T"), "prevContext"],
  ];

  for (const [label, event, command] of chords) {
    test(`${label} resolves to ${command}`, () => {
      assert.deepEqual(resolve("normal", event, "g"), { command, pending: "" });
    });
  }

  test("a non-chord key clears pending and resolves normally", () => {
    assert.deepEqual(resolve("normal", key("j"), "g"), { command: "down", pending: "" });
  });

  for (let digit = 1; digit <= 9; digit += 1) {
    test(`${digit} selects context ${digit}`, () => {
      assert.deepEqual(resolve("normal", key(String(digit))), {
        command: `context:${digit}`,
        pending: "",
      });
    });
  }

  test("Escape clears a retained filter before quitting", () => {
    assert.deepEqual(resolve("normal", key("escape"), "", true), {
      command: "clearFilter",
      pending: "",
    });
  });

  test("unknown keys resolve to none", () => {
    assert.deepEqual(resolve("normal", key("x")), { command: "none", pending: "" });
  });

  test("unmapped shifted keys do not resolve as lowercase commands", () => {
    assert.deepEqual(resolve("normal", key("j", { shift: true })), {
      command: "none",
      pending: "",
    });
  });
});

describe("resolveKey filter mode", () => {
  const cases: Array<[string, KeyEvent, Command]> = [
    ["Escape", key("escape"), "none"],
    ["Enter", key("return"), "open"],
    ["ctrl-n", key("n", { ctrl: true }), "down"],
    ["down arrow", key("down"), "down"],
    ["ctrl-p", key("p", { ctrl: true }), "up"],
    ["up arrow", key("up"), "up"],
    ["ctrl-c", key("c", { ctrl: true }), "quit"],
    ["printable", key("a"), "none"],
    ["Backspace", key("backspace"), "none"],
  ];

  for (const [label, event, command] of cases) {
    test(`${label} resolves to ${command}`, () => {
      assert.deepEqual(resolve("filter", event, "g"), { command, pending: "" });
    });
  }
});

describe("resolveKey PR screen", () => {
  const cases: Array<[string, KeyEvent, Command]> = [
    ["tab", key("tab"), "nextTab"],
    ["shift-tab", key("tab", { shift: true }), "prevTab"],
    ["l", key("l"), "nextTab"],
    ["right", key("right"), "nextTab"],
    ["h", key("h"), "prevTab"],
    ["left", key("left"), "prevTab"],
    ["b", key("b"), "browse"],
    ["p", key("p"), "back"],
    ["q", key("q"), "back"],
    ["escape", key("escape"), "back"],
    ["ctrl-c", key("c", { ctrl: true }), "quit"],
    ["U", key("u", { shift: true }), "update"],
  ];

  for (const [label, event, command] of cases) {
    test(`${label} resolves to ${command}`, () => {
      assert.deepEqual(resolve("normal", event, "", false, "prs"), {
        command,
        pending: "",
      });
    });
  }

  test("keeps navigation and context chords working", () => {
    assert.equal(resolve("normal", key("g"), "", false, "prs").pending, "g");
    assert.equal(resolve("normal", key("g"), "g", false, "prs").command, "top");
    assert.equal(resolve("normal", key("t"), "g", false, "prs").command, "nextContext");
    assert.equal(
      resolve("normal", key("t", { shift: true }), "g", false, "prs").command,
      "prevContext",
    );
  });

  test("Escape clears a retained PR filter before going back", () => {
    assert.equal(resolve("normal", key("escape"), "", true, "prs").command, "clearFilter");
  });
});

describe("resolveKey dialog mode", () => {
  test("ctrl-c quits", () => {
    assert.deepEqual(resolve("dialog", key("c", { ctrl: true })), {
      command: "quit",
      pending: "",
    });
  });

  const dialogOwnedKeys: Array<[string, KeyEvent]> = [
    ["Escape", key("escape")],
    ["Enter", key("return")],
    ["Tab", key("tab")],
    ["S-Tab", key("tab", { shift: true })],
    ["ctrl-n", key("n", { ctrl: true })],
    ["ctrl-p", key("p", { ctrl: true })],
    ["down arrow", key("down")],
    ["up arrow", key("up")],
  ];

  for (const [label, event] of dialogOwnedKeys) {
    test(`${label} is owned by the dialog`, () => {
      assert.deepEqual(resolve("dialog", event, "g"), { command: "none", pending: "" });
    });
  }
});

test("footer hints exist for both panes and palette commands are unique", () => {
  assert.ok(KEY_HINTS.repos.length > 0);
  assert.ok(KEY_HINTS.worktrees.length > 0);
  assert.ok(KEY_HINTS.repos.some(({ key: hint }) => hint === "U"));
  assert.ok(KEY_HINTS.worktrees.some(({ key: hint }) => hint === "U"));
  assert.deepEqual(
    COMMANDS.find(({ command }) => command === "update"),
    { command: "update", label: "Update swarm", keys: "U", screens: ["main", "prs"] },
  );
  assert.equal(new Set(COMMANDS.map(({ command }) => command)).size, COMMANDS.length);
  assert.ok(COMMANDS.every(({ screens }) => screens.length > 0));
  assert.equal(resolve("normal", key("p")).command, "prs");
});
