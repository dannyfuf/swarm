import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateSession, relativeTime, runningLabel, stateGlyph, tildePath } from "./format.ts";
import { glyphs, theme } from "./theme.ts";

const NOW = Date.parse("2026-09-02T12:00:00.000Z");

function ago(milliseconds: number): string {
  return new Date(NOW - milliseconds).toISOString();
}

test("relativeTime renders compact recency", () => {
  assert.equal(relativeTime(ago(0), NOW), "now");
  assert.equal(relativeTime(ago(20_000), NOW), "now");
  assert.equal(relativeTime(ago(5 * 60_000), NOW), "5m ago");
  assert.equal(relativeTime(ago(3 * 3_600_000), NOW), "3h ago");
  assert.equal(relativeTime(ago(2 * 86_400_000), NOW), "2d ago");
  assert.equal(relativeTime(ago(20 * 86_400_000), NOW), "2w ago");
  assert.equal(relativeTime(ago(800 * 86_400_000), NOW), "2y ago");
});

test("relativeTime never exceeds the 7 cell column", () => {
  for (const milliseconds of [0, 60_000, 3_600_000, 86_400_000, 1e10, 1e12]) {
    assert.ok(relativeTime(ago(milliseconds), NOW).length <= 7);
  }
});

test("relativeTime handles missing and unparsable timestamps", () => {
  assert.equal(relativeTime(undefined, NOW), "never");
  assert.equal(relativeTime("not-a-date", NOW), "never");
});

test("tildePath collapses the home prefix", () => {
  assert.equal(tildePath("/home/test/.swarm/repos/a", "/home/test"), "~/.swarm/repos/a");
  assert.equal(tildePath("/elsewhere/a", "/home/test"), "/elsewhere/a");
  assert.equal(tildePath("/home/test/a", ""), "/home/test/a");
});

test("stateGlyph maps session state to glyph and colour", () => {
  assert.deepEqual(stateGlyph("attached"), { char: glyphs.attached, fg: theme.green });
  assert.deepEqual(stateGlyph("detached"), { char: glyphs.detached, fg: theme.yellow });
  assert.deepEqual(stateGlyph("none"), { char: glyphs.none, fg: theme.dim });
  assert.deepEqual(stateGlyph(undefined), { char: glyphs.none, fg: theme.dim });
});

test("runningLabel joins keep-alive labels", () => {
  assert.equal(
    runningLabel({
      worktreeId: "o/n#s",
      session: "detached",
      windows: [],
      running: ["claude", ":3000"],
    }),
    "claude · :3000",
  );
  assert.equal(
    runningLabel({ worktreeId: "o/n#s", session: "none", windows: [], running: [] }),
    "",
  );
  assert.equal(runningLabel(undefined), "");
});

test("aggregateSession prefers the strongest state", () => {
  assert.equal(aggregateSession(["none", "detached", "attached"]), "attached");
  assert.equal(aggregateSession(["none", "detached"]), "detached");
  assert.equal(aggregateSession([undefined, "none"]), "none");
  assert.equal(aggregateSession([]), "none");
});
