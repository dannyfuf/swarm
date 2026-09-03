import assert from "node:assert/strict";
import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SwarmError } from "../core/errors.ts";
import { createFakeShell } from "../testing/fakeShell.ts";
import { createNullLogger } from "../testing/nullLogger.ts";
import { createRemoteHost, sshArgv, sshInteractiveCommand } from "./remoteHost.ts";
import { createShell } from "./shell.ts";

const host = { id: "devbox", ssh: "devbox", swarmCommand: "swarm" };

test("sshArgv quotes every remote argument for POSIX sh", () => {
  assert.deepEqual(
    sshArgv(host, ["create", "owner/repo", "a slug's work", "--json"], "/home/me/.swarm"),
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      "-o",
      "ControlMaster=auto",
      "-o",
      "ControlPath=/home/me/.swarm/cache/ssh/%C",
      "-o",
      "ControlPersist=120",
      "--",
      "devbox",
      `swarm 'create' 'owner/repo' 'a slug'"'"'s work' '--json'`,
    ],
  );
  assert.equal(
    sshInteractiveCommand(host, "owner/repo#a-slug"),
    "ssh -t -- devbox swarm open 'owner/repo#a-slug'",
  );
});

test("remote host adapter prepares a private control socket directory and never passes stdin", async () => {
  const home = await mkdtemp(join(tmpdir(), "swarm-remote-host-"));
  const shell = createFakeShell([{ match: (cmd) => cmd === "ssh", result: { stdout: "ok" } }]);
  const remote = createRemoteHost(shell, home);

  await remote.run(host, ["list", "--json"], { timeoutMs: 1234 });
  await remote.run(host, ["status", "--json"]);

  assert.equal((await stat(join(home, "cache", "ssh"))).mode & 0o777, 0o700);
  assert.equal(shell.calls.length, 2);
  assert.deepEqual(shell.calls[0]?.opts, { timeoutMs: 1234 });
  assert.equal("input" in (shell.calls[0]?.opts ?? {}), false);
});

test("remote host adapter terminates a timed-out ssh child and rejects as remote", async () => {
  const home = await mkdtemp(join(tmpdir(), "swarm-remote-timeout-"));
  const fakeSsh = join(home, "ssh");
  await writeFile(fakeSsh, "#!/bin/sh\nwhile :; do :; done\n");
  await chmod(fakeSsh, 0o700);
  const remote = createRemoteHost(createShell(createNullLogger()), home, fakeSsh);

  await assert.rejects(remote.run(host, ["status", "--json"], { timeoutMs: 250 }), (error) => {
    assert.ok(error instanceof SwarmError);
    assert.equal(error.code, "remote");
    assert.match(error.message, /command timed out/);
    return true;
  });
});
