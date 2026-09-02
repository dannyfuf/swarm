import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cell,
  fitLine,
  ghostLine,
  highlight,
  lineText,
  lineWidth,
  pad,
  padStart,
  spread,
  truncate,
  truncateStart,
  withBackground,
} from "./text.ts";
import { theme } from "./theme.ts";

test("truncate keeps the width and marks the cut", () => {
  assert.equal(truncate("feat/payroll", 20), "feat/payroll");
  assert.equal(truncate("feat/payroll", 6), "feat/…");
  assert.equal(truncate("feat/payroll", 1), "…");
  assert.equal(truncate("feat/payroll", 0), "");
});

test("truncateStart keeps the tail of a path", () => {
  assert.equal(truncateStart("/a/b/c/d", 6), "…b/c/d");
  assert.equal(truncateStart("/a/b", 10), "/a/b");
});

test("pad and padStart produce exactly the requested width", () => {
  assert.equal(pad("ab", 5), "ab   ");
  assert.equal(pad("abcdef", 4), "abc…");
  assert.equal(padStart("ab", 5), "   ab");
  assert.equal(padStart("abcdef", 4), "abc…");
});

test("fitLine pads short lines and clips long ones", () => {
  const short = fitLine([cell("ab", { fg: theme.text })], 6);
  assert.equal(lineText(short), "ab    ");
  assert.equal(lineWidth(short), 6);

  const long = fitLine([cell("abc"), cell("def"), cell("ghi")], 5);
  assert.equal(lineWidth(long), 5);
  assert.equal(lineText(long), "abcd…");
});

test("spread pins the right side to the end of the width", () => {
  const line = spread([cell("left")], [cell("right")], 20);
  assert.equal(lineWidth(line), 20);
  assert.equal(lineText(line), "left           right");
});

test("spread never overflows when both sides are long", () => {
  const line = spread([cell("aaaaaaaaaa")], [cell("bbbbbbbbbb")], 12);
  assert.equal(lineWidth(line), 12);
});

test("highlight splits matched runs into their own cells", () => {
  const base = { fg: theme.text };
  const match = { fg: theme.yellow };
  const line = highlight("payroll", [0, 1, 2], base, match);
  assert.deepEqual(
    line.map((part) => [part.text, part.fg]),
    [
      ["pay", theme.yellow],
      ["roll", theme.text],
    ],
  );
  assert.equal(lineText(line), "payroll");
});

test("highlight honours an offset and an empty match set", () => {
  const line = highlight("abcd", [0], { fg: theme.text }, { fg: theme.yellow }, 2);
  assert.deepEqual(
    line.map((part) => part.text),
    ["ab", "c", "d"],
  );
  assert.equal(highlight("abcd", [], { fg: theme.text }, { fg: theme.yellow }).length, 1);
});

test("withBackground paints every cell and ghostLine flattens colour", () => {
  const line = withBackground([cell("a", { fg: theme.text }), cell("b")], theme.cursorBg);
  assert.ok(line.every((part) => part.bg === theme.cursorBg));

  const ghost = ghostLine([cell("a", { fg: theme.green, bg: theme.cursorBg, bold: true })]);
  assert.deepEqual(ghost, [{ text: "a", fg: theme.ghost }]);
});
