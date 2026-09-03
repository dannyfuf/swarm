import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakeShell } from "../testing/fakeShell.ts";
import { createRemoteHost, sshArgv, sshInteractiveCommand } from "./remoteHost.ts";

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
