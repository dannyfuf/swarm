import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { UpdateEvent } from "../core/ports.ts";
import { createFakeFiles } from "../testing/fakeFiles.ts";
import { createFakeShell, type FakeShellRule } from "../testing/fakeShell.ts";
import { createNullLogger } from "../testing/nullLogger.ts";
import { createUpdater } from "./updater.ts";

const root = "/opt/swarm";

function gitRule(args: string[], result: FakeShellRule["result"]): FakeShellRule {
  return { match: (cmd, actual) => cmd === "git" && actual.join(" ") === args.join(" "), result };
}

function validGitRules(): FakeShellRule[] {
  return [
    gitRule(["rev-parse", "--is-inside-work-tree"], { stdout: "true\n" }),
    gitRule(["branch", "--show-current"], { stdout: "main\n" }),
    gitRule(["status", "--porcelain"], { stdout: "" }),
    gitRule(["pull", "--ff-only", "origin", "main"], { stdout: "Already up to date.\n" }),
  ];
}

describe("updater", () => {
  test("pulls, installs from the lockfile, and builds sequentially in the install root", async () => {
    const shell = createFakeShell([
      ...validGitRules(),
      { match: (cmd, args) => cmd === "npm" && args[0] === "ci", result: {} },
      {
        match: (cmd, args) => cmd === "npm" && args.join(" ") === "run build",
        result: {},
      },
    ]);
    const updater = createUpdater({
      shell,
      files: createFakeFiles({ paths: [`${root}/package-lock.json`] }),
      logger: createNullLogger(),
    });
    const events: UpdateEvent[] = [];

    await updater.update(root, (event) => events.push(event));

    assert.deepEqual(
      shell.calls.map(({ cmd, args }) => [cmd, ...args]),
      [
        ["git", "rev-parse", "--is-inside-work-tree"],
        ["git", "branch", "--show-current"],
        ["git", "status", "--porcelain"],
        ["git", "pull", "--ff-only", "origin", "main"],
        ["npm", "ci"],
        ["npm", "run", "build"],
      ],
    );
    assert.ok(shell.calls.every(({ opts }) => opts?.cwd === root));
    assert.deepEqual(
      events.filter((event) => event.type === "step").map((event) => event.label),
      [
        "checking install…",
        "checking working tree…",
        "pulling main…",
        "installing dependencies…",
        "building…",
      ],
    );
  });

  test("refuses a non-main branch before status or mutating commands", async () => {
    const shell = createFakeShell([
      gitRule(["rev-parse", "--is-inside-work-tree"], { stdout: "true\n" }),
      gitRule(["branch", "--show-current"], { stdout: "feature\n" }),
    ]);
    const updater = createUpdater({
      shell,
      files: createFakeFiles(),
      logger: createNullLogger(),
    });

    await assert.rejects(
      () => updater.update(root),
      /update requires the main branch \(current: feature\)/u,
    );
    assert.equal(shell.calls.length, 2);
  });

  test("refuses a dirty tree before pull or npm commands", async () => {
    const rules = validGitRules();
    rules[2] = gitRule(["status", "--porcelain"], { stdout: " M src/main.ts\n" });
    const shell = createFakeShell(rules);
    const updater = createUpdater({
      shell,
      files: createFakeFiles(),
      logger: createNullLogger(),
    });

    await assert.rejects(() => updater.update(root), /update requires a clean working tree/u);
    assert.deepEqual(
      shell.calls.map(({ args }) => args[0]),
      ["rev-parse", "branch", "status"],
    );
  });

  test("includes the failing step and stderr tail when the build fails", async () => {
    const shell = createFakeShell([
      ...validGitRules(),
      { match: (cmd, args) => cmd === "npm" && args[0] === "install", result: {} },
      {
        match: (cmd, args) => cmd === "npm" && args.join(" ") === "run build",
        result: { code: 1, stderr: "first line\nTypeScript exploded\n" },
      },
    ]);
    const logger = createNullLogger();
    const updater = createUpdater({ shell, files: createFakeFiles(), logger });

    await assert.rejects(
      () => updater.update(root),
      /Updating swarm: building failed: first line \| TypeScript exploded/u,
    );
    assert.deepEqual(logger.entries.at(-1)?.data, {
      cwd: root,
      command: "npm run build",
      code: 1,
      stdout: "",
      stderr: "first line\nTypeScript exploded\n",
    });
  });
});
