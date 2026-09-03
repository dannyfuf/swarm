import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SwarmError } from "../core/errors.ts";
import { createFakeShell } from "../testing/fakeShell.ts";
import { createNullLogger } from "../testing/nullLogger.ts";
import { createFiles } from "./files.ts";
import { createShell } from "./shell.ts";

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error("Timed out waiting for detached file operation");
}

describe("files adapter", () => {
  test("uses platform-specific clone argv and verifies the destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "swarm-files-"));
    try {
      const cases: Array<[NodeJS.Platform, string[]]> = [
        ["darwin", ["-Rc", `${root}/src`, `${root}/darwin`]],
        ["linux", ["-R", "--reflink=auto", `${root}/src`, `${root}/linux`]],
        ["win32", ["-R", `${root}/src`, `${root}/win32`]],
      ];
      for (const [platform, expectedArgs] of cases) {
        const destination = expectedArgs.at(-1);
        assert.ok(destination);
        await mkdir(destination);
        const shell = createFakeShell([{ match: (cmd) => cmd === "cp", result: {} }]);
        await createFiles(shell, createNullLogger(), platform).cloneTree(
          `${root}/src`,
          destination,
        );
        assert.deepEqual(
          shell.calls.map(({ cmd, args }) => [cmd, args]),
          [["cp", expectedArgs]],
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("launches copy and atomic publish as one detached shell job", async () => {
    const cases: Array<[NodeJS.Platform, string]> = [
      ["darwin", 'cp -Rc "$source_path" "$staging_path"'],
      ["linux", 'cp -R --reflink=auto "$source_path" "$staging_path"'],
      ["win32", 'cp -R "$source_path" "$staging_path"'],
    ];

    for (const [platform, expectedCopy] of cases) {
      const shell = createFakeShell();
      const files = createFiles(shell, createNullLogger(), platform);
      const pid = await files.cloneTreeDetached(
        "/repo",
        "/worktrees/owner/repo/.hot.staging",
        "/worktrees/owner/repo/.hot",
        "/worktrees/owner/repo/.hot.staging.pid",
        "/logs/hot-copy-owner-repo.log",
      );

      assert.equal(pid, 4242);
      const call = shell.detachedCalls[0];
      assert.equal(call?.cmd, "sh");
      assert.deepEqual(call?.args.slice(0, 2), ["-c", call.args[1]]);
      assert.deepEqual(call?.args.slice(2), [
        "swarm-hot-copy",
        "/repo",
        "/worktrees/owner/repo/.hot.staging",
        "/worktrees/owner/repo/.hot",
        "/worktrees/owner/repo/.hot.staging.pid",
      ]);
      assert.deepEqual(call?.opts, { logPath: "/logs/hot-copy-owner-repo.log" });
      const script = call?.args[1] ?? "";
      assert.equal(script.includes(expectedCopy), true);
      assert.match(script, /&& mv "\$staging_path" "\$hot_path"/u);
      assert.match(script, /if \[ "\$status" -ne 0 \]; then rm -rf "\$staging_path"; fi/u);
      assert.match(script, /printf '%s\\n' "\$\$" > "\$pid_path"/u);
    }
  });

  test("detached clone publishes complete output and removes staging after failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "swarm-files-detached-"));
    try {
      const source = join(root, "source");
      const staging = join(root, ".hot.staging");
      const hot = join(root, ".hot");
      const pidPath = join(root, ".hot.staging.pid");
      const logPath = join(root, "hot-copy.log");
      await mkdir(source);
      await writeFile(join(source, "complete.txt"), "complete");
      const files = createFiles(createShell(createNullLogger()), createNullLogger());

      await files.cloneTreeDetached(source, staging, hot, pidPath, logPath);
      await waitUntil(
        async () =>
          (await files.exists(join(hot, "complete.txt"))) && !(await files.exists(pidPath)),
      );
      assert.equal(await files.exists(staging), false);
      assert.equal(await files.exists(pidPath), false);
      assert.equal(await readFile(join(hot, "complete.txt"), "utf8"), "complete");

      const failedStaging = join(root, ".failed.staging");
      const failedHot = join(root, ".failed");
      const failedPid = join(root, ".failed.pid");
      await mkdir(failedStaging);
      await writeFile(join(failedStaging, "partial.txt"), "partial");
      await files.cloneTreeDetached(
        join(root, "missing-source"),
        failedStaging,
        failedHot,
        failedPid,
        logPath,
      );
      await waitUntil(
        async () => !(await files.exists(failedStaging)) && !(await files.exists(failedPid)),
      );
      assert.equal(await files.exists(failedHot), false);
      assert.equal(await files.exists(failedPid), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("writes atomically and supports filesystem operations", async () => {
    const root = await mkdtemp(join(tmpdir(), "swarm-files-"));
    try {
      const files = createFiles(createFakeShell(), createNullLogger(), process.platform, [root]);
      const nested = join(root, "nested");
      const path = join(nested, "state.json");
      await files.ensureDir(nested);
      await files.writeTextAtomic(path, "first");
      assert.equal(await files.readText(path), "first");
      const entries = await readdir(nested);
      assert.deepEqual(
        entries.filter((entry) => entry.includes(".tmp-")),
        [],
      );
      assert.equal(await files.exists(path), true);
      assert.equal(await files.readText(join(root, "missing")), null);

      await Promise.all([
        files.writeTextAtomic(path, "second"),
        files.writeTextAtomic(path, "third"),
      ]);
      assert.ok(["second", "third"].includes((await files.readText(path)) ?? ""));

      await mkdir(join(root, "z-dir"));
      await mkdir(join(root, "a-dir"));
      await mkdir(join(root, ".hot"));
      await mkdir(join(root, ".hot.staging"));
      await writeFile(join(root, "file.txt"), "not a directory");
      assert.deepEqual(await files.listDirs(root), ["a-dir", "nested", "z-dir"]);

      const moved = join(nested, "moved.json");
      await files.move(path, moved);
      assert.ok(["second", "third"].includes((await files.readText(moved)) ?? ""));
      assert.equal(await files.exists(path), false);

      const removable = join(root, "remove-me", "nested");
      await files.ensureDir(removable);
      await files.removeTree(join(root, "remove-me"));
      assert.equal(await files.exists(removable), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("guards unsafe detached removals and invokes one safe rm", async () => {
    const shell = createFakeShell();
    const files = createFiles(shell, createNullLogger(), process.platform, ["/tmp/swarm-trash"]);
    const unsafe = [
      "/",
      "/tmp/x",
      "/tmp/swarm-trash",
      ...(process.env.HOME ? [process.env.HOME] : []),
    ];
    for (const path of unsafe) {
      await assert.rejects(
        files.removeDetached(path),
        (error: unknown) => error instanceof SwarmError && error.code === "validation",
      );
      await assert.rejects(
        files.removeTree(path),
        (error: unknown) => error instanceof SwarmError && error.code === "validation",
      );
    }

    await files.removeDetached("/tmp/swarm-trash/item");
    assert.deepEqual(
      shell.detachedCalls.map(({ cmd, args }) => [cmd, args]),
      [["rm", ["-rf", "/tmp/swarm-trash/item"]]],
    );
  });
});
