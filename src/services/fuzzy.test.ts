import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fuzzyFilter } from "../core/fuzzy.ts";

describe("fuzzyFilter", () => {
  test("prefers consecutive word-boundary matches", () => {
    const matches = fuzzyFilter("pay", ["deploy-happy", "feat/payroll-fix"], (item) => item);
    assert.deepEqual(
      matches.map(({ item }) => item),
      ["feat/payroll-fix", "deploy-happy"],
    );
    assert.deepEqual(matches[0]?.positions, [5, 6, 7]);
  });

  test("matches case-insensitively and recognizes camel-case boundaries", () => {
    const [match] = fuzzyFilter("pf", ["PayrollFix"], (item) => item);
    assert.deepEqual(match?.positions, [0, 7]);
  });

  test("returns an empty query in original order", () => {
    const items = ["third", "first", "second"];
    assert.deepEqual(
      fuzzyFilter("", items, (item) => item).map(({ item }) => item),
      items,
    );
  });

  test("excludes items without a subsequence match", () => {
    assert.deepEqual(
      fuzzyFilter("xyz", ["payroll", "deploy"], (item) => item),
      [],
    );
  });

  test("uses original order to break equal scores", () => {
    assert.deepEqual(
      fuzzyFilter("ab", ["ab", "ab"], (item) => item).map(({ item }) => item),
      ["ab", "ab"],
    );
  });
});
