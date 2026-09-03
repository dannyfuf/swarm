import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveVersion, VERSION } from "./version.ts";

test("uses the build version and falls back to the package development version", () => {
  assert.equal(resolveVersion("1.2.3+abc1234", "1.2.3"), "1.2.3+abc1234");
  assert.equal(resolveVersion(undefined, "1.2.3"), "1.2.3+dev");
  assert.equal(VERSION, "0.1.0+dev");
});
