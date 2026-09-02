import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { SwarmError } from "../core/errors.ts";
import { createFakeShell } from "../testing/fakeShell.ts";
import { createNullLogger } from "../testing/nullLogger.ts";
import { createFiles } from "./files.ts";

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
      await writeFile(join(root, "file.txt"), "not a directory");
      assert.deepEqual(await files.listDirs(root), ["a-dir", "nested", "z-dir"]);

      const moved = join(nested, "moved.json");
      await files.move(path, moved);
      assert.ok(["second", "third"].includes((await files.readText(moved)) ?? ""));
      assert.equal(await files.exists(path), false);
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
    }

    await files.removeDetached("/tmp/swarm-trash/item");
    assert.deepEqual(
      shell.detachedCalls.map(({ cmd, args }) => [cmd, args]),
      [["rm", ["-rf", "/tmp/swarm-trash/item"]]],
    );
  });
});
