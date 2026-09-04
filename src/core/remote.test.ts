import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  quotePosixArg,
  sshCommonOptions,
  sshInteractiveCommand,
  sshPaneCommand,
} from "./remote.ts";

const host = { id: "devbox", ssh: "user@devbox", swarmCommand: "/opt/swarm" };

describe("remote command helpers", () => {
  test("quotes POSIX arguments including embedded single quotes", () => {
    assert.equal(quotePosixArg("plain"), "'plain'");
    assert.equal(quotePosixArg("it's"), `'it'"'"'s'`);
  });

  test("shares connection options without BatchMode", () => {
    const options = sshCommonOptions("/home/me/.swarm");
    assert.deepEqual(options, [
      "-o",
      "ConnectTimeout=5",
      "-o",
      "ControlMaster=auto",
      "-o",
      "ControlPath=/home/me/.swarm/cache/ssh/%C",
      "-o",
      "ControlPersist=120",
    ]);
    assert.ok(!options.some((option) => option.startsWith("BatchMode")));
  });

  test("interactive command keeps -t, adds the shared options, and omits BatchMode", () => {
    const command = sshInteractiveCommand(host, "owner/repo#a-slug", "/home/me/.swarm");
    assert.equal(
      command,
      "ssh -t -o 'ConnectTimeout=5' -o 'ControlMaster=auto' -o 'ControlPath=/home/me/.swarm/cache/ssh/%C' -o 'ControlPersist=120' -- user@devbox /opt/swarm open 'owner/repo#a-slug'",
    );
    assert.match(command, /^ssh -t /u);
    assert.match(command, /ControlPath=/u);
    assert.match(command, /ConnectTimeout=/u);
    assert.doesNotMatch(command, /BatchMode/u);
  });

  test("quotes a swarm home containing spaces and quotes in the interactive command", () => {
    const command = sshInteractiveCommand(host, "owner/repo#slug", "/Users/o'brien/my home");
    assert.ok(
      command.includes(`-o 'ControlPath=/Users/o'"'"'brien/my home/cache/ssh/%C'`),
      command,
    );
  });

  test("pane wrapper reports the ssh exit status and waits before closing", () => {
    const wrapped = sshPaneCommand("ssh -t -- devbox swarm open 'owner/repo#slug'");
    assert.equal(
      wrapped,
      `sh -c 'ssh -t -- devbox swarm open '"'"'owner/repo#slug'"'"' || { status=$?; printf "\\nswarm: remote open failed (exit %s) - press Enter to close\\n" "$status"; IFS= read -r _; }'`,
    );
    assert.match(wrapped, /^sh -c '/u);
    // The status is captured before printf runs so the message shows ssh's exit code.
    assert.match(wrapped, /\|\| \{ status=\$\?; printf /u);
    assert.match(wrapped, /"\$status"; IFS= read -r _; \}'$/u);
  });
});
