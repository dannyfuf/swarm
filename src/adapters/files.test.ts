import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { SwarmError } from "../core/errors.ts";
import { createFakeShell } from "../testing/fakeShell.ts";
import { createNullLogger } from "../testing/nullLogger.ts";
import { createFiles } from "./files.ts";
import { createShell } from "./shell.ts";

describe("files adapter", () => {
  test("clones a tree end to end with nested content and symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "swarm-files-"));
    try {
      const source = join(root, "source");
      const nested = join(source, "nested");
      const destination = join(root, "copies", "destination");
      await mkdir(nested, { recursive: true });
      await writeFile(join(source, "root.txt"), "root content");
      await writeFile(join(nested, "child.txt"), "nested content");
      await symlink("../root.txt", join(nested, "root-link"));

      const logger = createNullLogger();
      await createFiles(createShell(logger), logger).cloneTree(source, destination);

      assert.equal(await readFile(join(destination, "root.txt"), "utf8"), "root content");
      assert.equal(
        await readFile(join(destination, "nested", "child.txt"), "utf8"),
        "nested content",
      );
      const copiedLink = join(destination, "nested", "root-link");
      assert.equal((await lstat(copiedLink)).isSymbolicLink(), true);
      assert.equal(await readlink(copiedLink), "../root.txt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses the macOS fast path and platform-specific cp elsewhere", async () => {
    const root = await mkdtemp(join(tmpdir(), "swarm-files-"));
    try {
      const macDestination = join(root, "darwin");
      const cloned: Array<[string, string]> = [];
      const macShell = createFakeShell();
      await createFiles(macShell, createNullLogger(), "darwin", [], {
        async cloneDirectory(src, dest) {
          cloned.push([src, dest]);
          await mkdir(dest);
        },
      }).cloneTree(`${root}/src`, macDestination);
      assert.deepEqual(cloned, [[`${root}/src`, macDestination]]);
      assert.deepEqual(macShell.calls, []);

      const cases: Array<[NodeJS.Platform, string[]]> = [
        ["linux", ["-R", "--reflink=auto", `${root}/src`, `${root}/linux`]],
        ["win32", ["-R", `${root}/src`, `${root}/win32`]],
      ];
      for (const [platform, expectedArgs] of cases) {
        const destination = expectedArgs.at(-1);
        assert.ok(destination);
        const shell = createFakeShell([
          {
            match: (cmd) => cmd === "cp",
            result: () => {
              mkdirSync(destination);
              return {};
            },
          },
        ]);
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

  test("falls back to cp -Rc and logs the clonefile failure once", async () => {
    const root = await mkdtemp(join(tmpdir(), "swarm-files-"));
    try {
      const shell = createFakeShell([
        {
          match: (cmd) => cmd === "cp",
          result: (_cmd, args) => {
            const destination = args.at(-1);
            assert.ok(destination);
            mkdirSync(destination);
            return {};
          },
        },
      ]);
      const logger = createNullLogger();
      const files = createFiles(shell, logger, "darwin", [], {
        async cloneDirectory(_src, dest, onDestinationCreated) {
          await mkdir(dest);
          onDestinationCreated();
          await writeFile(join(dest, "partial"), "incomplete clone");
          throw new Error("forced clonefile failure");
        },
      });

      await files.cloneTree(`${root}/source-one`, `${root}/destination-one`);
      await files.cloneTree(`${root}/source-two`, `${root}/destination-two`);

      assert.deepEqual(
        shell.calls.map(({ cmd, args }) => [cmd, args]),
        [
          ["cp", ["-Rc", `${root}/source-one`, `${root}/destination-one`]],
          ["cp", ["-Rc", `${root}/source-two`, `${root}/destination-two`]],
        ],
      );
      assert.deepEqual(
        logger.entries.filter(({ level }) => level === "warn"),
        [
          {
            level: "warn",
            scope: "files",
            message: "Directory clonefile unavailable; falling back to cp -Rc",
            data: { reason: "forced clonefile failure" },
          },
        ],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not remove a clone destination created by a concurrent caller", async () => {
    const root = await mkdtemp(join(tmpdir(), "swarm-files-"));
    const destination = join(root, "winner");
    try {
      const files = createFiles(createFakeShell(), createNullLogger(), "darwin", [], {
        async cloneDirectory() {
          await mkdir(destination);
          await writeFile(join(destination, "owned-by-winner"), "keep");
          throw Object.assign(new Error("destination appeared"), { code: "EEXIST" });
        },
      });

      await assert.rejects(files.cloneTree(join(root, "source"), destination));

      assert.equal(await readFile(join(destination, "owned-by-winner"), "utf8"), "keep");
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
      await mkdir(join(root, ".hot.1"));
      await mkdir(join(root, ".hot.1.staging"));
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
