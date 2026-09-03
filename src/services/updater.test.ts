import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { UpdateEvent } from "../core/ports.ts";
import { createFakeFiles, type FakeFiles } from "../testing/fakeFiles.ts";
import { createFakeShell, type FakeShellRule } from "../testing/fakeShell.ts";
import { createNullLogger } from "../testing/nullLogger.ts";
import { createUpdater } from "./updater.ts";

const root = "/opt/swarm";
const home = "/home/dev";
const nvmDir = `${home}/.nvm`;
const nvmVersions = `${nvmDir}/versions/node`;
const swarmHome = "/home/dev/.swarm";
const cachePath = `${swarmHome}/cache/node-bin`;
const runningNodeBin = "/usr/local/bin/node";

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { HOME: home, NVM_DIR: nvmDir, SWARM_HOME: swarmHome, PATH: "/usr/bin", ...overrides };
}

interface FakeFilesOptions {
  nvmrc?: string | null;
  nvmInstalls?: string[];
  nodenvInstalls?: string[];
  lockfile?: boolean;
  nvmScript?: boolean;
}

function updaterFiles({
  nvmrc = "26.8.1\n",
  nvmInstalls = ["v26.8.1"],
  nodenvInstalls = [],
  lockfile = true,
  nvmScript = false,
}: FakeFilesOptions = {}): FakeFiles {
  const paths = [
    ...nvmInstalls.map((name) => `${nvmVersions}/${name}/bin/node`),
    ...nodenvInstalls.map((name) => `${home}/.nodenv/versions/${name}/bin/node`),
  ];
  if (lockfile) paths.push(`${root}/package-lock.json`);
  if (nvmScript) paths.push(`${nvmDir}/nvm.sh`);
  return createFakeFiles({
    paths,
    texts: nvmrc === null ? {} : { [`${root}/.nvmrc`]: nvmrc },
  });
}

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

function npmRules(binDir: string): FakeShellRule[] {
  return [
    {
      match: (cmd, args) => cmd === `${binDir}/npm` && (args[0] === "ci" || args[0] === "install"),
      result: {},
    },
    { match: (cmd, args) => cmd === `${binDir}/npm` && args.join(" ") === "run build", result: {} },
  ];
}

describe("updater", () => {
  test("pulls, installs from the lockfile, and builds with the npm pinned by .nvmrc", async () => {
    const binDir = `${nvmVersions}/v26.8.1/bin`;
    const shell = createFakeShell([...validGitRules(), ...npmRules(binDir)]);
    const updater = createUpdater({
      shell,
      files: updaterFiles(),
      logger: createNullLogger(),
      env: env(),
      execPath: runningNodeBin,
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
        [`${binDir}/npm`, "ci"],
        [`${binDir}/npm`, "run", "build"],
      ],
    );
    assert.ok(shell.calls.every(({ opts }) => opts?.cwd === root));
    for (const call of shell.calls.slice(4)) {
      assert.deepEqual((call.opts as { env?: Record<string, string> }).env, {
        PATH: `${binDir}:/usr/bin`,
      });
    }
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

  test("matches a partial .nvmrc version against the highest install", async () => {
    const binDir = `${nvmVersions}/v26.8.1/bin`;
    const shell = createFakeShell([...validGitRules(), ...npmRules(binDir)]);
    const updater = createUpdater({
      shell,
      files: updaterFiles({
        nvmrc: "v26\n",
        nvmInstalls: ["v24.19.0", "v26.5.0", "v26.8.1", "v26.10.0-broken"],
      }),
      logger: createNullLogger(),
      env: env(),
      execPath: runningNodeBin,
    });

    await updater.update(root);

    assert.deepEqual(
      shell.calls.filter(({ cmd }) => cmd.endsWith("npm")).map(({ cmd }) => cmd),
      [`${binDir}/npm`, `${binDir}/npm`],
    );
  });

  test("falls back to a nodenv install when nvm has no match", async () => {
    const binDir = `${home}/.nodenv/versions/26.8.4/bin`;
    const shell = createFakeShell([...validGitRules(), ...npmRules(binDir)]);
    const updater = createUpdater({
      shell,
      files: updaterFiles({
        nvmrc: "26.8",
        nvmInstalls: ["v24.19.0"],
        nodenvInstalls: ["26.8.1", "26.8.4", "20.20.0"],
      }),
      logger: createNullLogger(),
      env: env(),
      execPath: runningNodeBin,
    });

    await updater.update(root);

    assert.deepEqual(
      shell.calls.filter(({ cmd }) => cmd.endsWith("npm")).map(({ cmd, args }) => [cmd, ...args]),
      [
        [`${binDir}/npm`, "ci"],
        [`${binDir}/npm`, "run", "build"],
      ],
    );
  });

  test("falls back to the running node when .nvmrc is missing", async () => {
    const binDir = "/usr/local/bin";
    const shell = createFakeShell([...validGitRules(), ...npmRules(binDir)]);
    const files = updaterFiles({ nvmrc: null, nvmInstalls: [] });
    const logger = createNullLogger();
    const updater = createUpdater({
      shell,
      files,
      logger,
      env: env(),
      execPath: runningNodeBin,
    });

    await updater.update(root);

    assert.deepEqual(
      shell.calls.filter(({ cmd }) => cmd.endsWith("npm")).map(({ cmd }) => cmd),
      [`${binDir}/npm`, `${binDir}/npm`],
    );
    assert.deepEqual(
      logger.entries.find((entry) => entry.message === "Resolved node bin dir")?.data,
      { binDir, version: null, reason: "no .nvmrc, using the node running swarm" },
    );
    // The running node is already the pinned one, so the launcher cache stays untouched.
    assert.equal(files.texts.get(cachePath), undefined);
  });

  test("installs the pinned version with nvm when it is missing", async () => {
    const binDir = `${nvmVersions}/v26.8.1/bin`;
    const files = updaterFiles({ nvmInstalls: [], nvmScript: true });
    const shell = createFakeShell([
      ...validGitRules(),
      ...npmRules(binDir),
      {
        match: (cmd) => cmd === "bash",
        result: (_cmd, _args, opts) => {
          opts?.onStderrLine?.("Downloading...");
          files.paths.add(`${binDir}/node`);
          return { stderr: "Downloading...\n" };
        },
      },
    ]);
    const updater = createUpdater({
      shell,
      files,
      logger: createNullLogger(),
      env: env(),
      execPath: runningNodeBin,
    });
    const events: UpdateEvent[] = [];

    await updater.update(root, (event) => events.push(event));

    const install = shell.calls.find(({ cmd }) => cmd === "bash");
    assert.deepEqual(install?.args, ["-c", '. "$NVM_DIR/nvm.sh" && nvm install']);
    assert.equal(install?.opts?.cwd, root);
    assert.deepEqual((install?.opts as { env?: Record<string, string> } | undefined)?.env, {
      NVM_DIR: nvmDir,
    });
    assert.ok(
      events.some((event) => event.type === "step" && event.label === "installing node 26.8.1…"),
    );
    assert.ok(events.some((event) => event.type === "log" && event.line === "Downloading..."));
    assert.deepEqual(
      shell.calls.filter(({ cmd }) => cmd.endsWith("npm")).map(({ cmd }) => cmd),
      [`${binDir}/npm`, `${binDir}/npm`],
    );
  });

  test("reports the pinned version when it is missing and nvm is unavailable", async () => {
    const shell = createFakeShell(validGitRules());
    const updater = createUpdater({
      shell,
      files: updaterFiles({ nvmInstalls: [] }),
      logger: createNullLogger(),
      env: env(),
      execPath: runningNodeBin,
    });

    await assert.rejects(
      () => updater.update(root),
      /node 26\.8\.1 \(from \.nvmrc\) is not installed/u,
    );
    assert.ok(shell.calls.every(({ cmd }) => cmd === "git"));
  });

  test("caches the pinned node binary for the next launch", async () => {
    const binDir = `${nvmVersions}/v26.8.1/bin`;
    const files = updaterFiles();
    const shell = createFakeShell([...validGitRules(), ...npmRules(binDir)]);
    const updater = createUpdater({
      shell,
      files,
      logger: createNullLogger(),
      env: env(),
      execPath: runningNodeBin,
    });

    await updater.update(root);

    assert.equal(files.texts.get(cachePath), `${binDir}/node\n`);
  });

  test("keeps updating when the launcher cache cannot be written", async () => {
    const binDir = `${nvmVersions}/v26.8.1/bin`;
    const files = updaterFiles();
    files.writeTextAtomic = async () => {
      throw new Error("read-only volume");
    };
    const shell = createFakeShell([...validGitRules(), ...npmRules(binDir)]);
    const logger = createNullLogger();
    const updater = createUpdater({
      shell,
      files,
      logger,
      env: env(),
      execPath: runningNodeBin,
    });

    await updater.update(root);

    assert.ok(
      logger.entries.some(
        (entry) => entry.level === "warn" && entry.message === "Could not cache node binary",
      ),
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
      env: env(),
      execPath: runningNodeBin,
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
      env: env(),
      execPath: runningNodeBin,
    });

    await assert.rejects(() => updater.update(root), /update requires a clean working tree/u);
    assert.deepEqual(
      shell.calls.map(({ args }) => args[0]),
      ["rev-parse", "branch", "status"],
    );
  });

  test("includes the failing step and stderr tail when the build fails", async () => {
    const binDir = `${nvmVersions}/v26.8.1/bin`;
    const shell = createFakeShell([
      ...validGitRules(),
      { match: (cmd, args) => cmd === `${binDir}/npm` && args[0] === "install", result: {} },
      {
        match: (cmd, args) => cmd === `${binDir}/npm` && args.join(" ") === "run build",
        result: { code: 1, stderr: "first line\nTypeScript exploded\n" },
      },
    ]);
    const logger = createNullLogger();
    const updater = createUpdater({
      shell,
      files: updaterFiles({ lockfile: false }),
      logger,
      env: env(),
      execPath: runningNodeBin,
    });

    await assert.rejects(
      () => updater.update(root),
      /Updating swarm: building failed: first line \| TypeScript exploded/u,
    );
    assert.deepEqual(logger.entries.at(-1)?.data, {
      cwd: root,
      command: `${binDir}/npm run build`,
      code: 1,
      stdout: "",
      stderr: "first line\nTypeScript exploded\n",
    });
  });
});
