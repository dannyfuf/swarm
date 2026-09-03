import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SwarmError } from "../core/errors.ts";
import {
  agentCommandArgv,
  agentSessionName,
  isAgentName,
  parseTmuxSocket,
  stripTmuxEnv,
  tmuxAttachArgv,
} from "./agentPopup.ts";

describe("agent popup helpers", () => {
  test("recognizes supported agents and derives their commands and session names", () => {
    assert.equal(isAgentName("claude"), true);
    assert.equal(isAgentName("opencode"), true);
    assert.equal(isAgentName("codex"), false);
    assert.equal(agentSessionName("claude"), "swarm-agent-claude");
    assert.equal(agentSessionName("opencode"), "swarm-agent-opencode");
    assert.deepEqual(agentCommandArgv("claude --dangerously-skip-permissions"), [
      "claude --dangerously-skip-permissions",
    ]);
    assert.deepEqual(agentCommandArgv("opencode --model sonnet"), ["opencode --model sonnet"]);
  });

  test("parses the socket path from TMUX, including paths containing commas", () => {
    assert.equal(
      parseTmuxSocket("/private/tmp/tmux-501/default,1234,7"),
      "/private/tmp/tmux-501/default",
    );
    assert.equal(parseTmuxSocket("/tmp/socket,with,commas,42,0"), "/tmp/socket,with,commas");
    assert.equal(parseTmuxSocket(undefined), undefined);
  });

  test("rejects malformed TMUX values", () => {
    assert.throws(
      () => parseTmuxSocket("/tmp/socket"),
      (error: unknown) => error instanceof SwarmError && error.code === "tmux",
    );
  });

  test("builds attach argv for tmux popups and regular terminals", () => {
    assert.deepEqual(tmuxAttachArgv("swarm-agent-claude", "/tmp/tmux/default,123,0"), [
      "-S",
      "/tmp/tmux/default",
      "attach-session",
      "-t",
      "swarm-agent-claude",
    ]);
    assert.deepEqual(tmuxAttachArgv("swarm-agent-opencode", undefined), [
      "attach-session",
      "-t",
      "swarm-agent-opencode",
    ]);
  });

  test("removes TMUX without mutating or stripping unrelated environment values", () => {
    const env = { PATH: "/usr/bin", TMUX: "/tmp/tmux/default,123,0", TMUX_PANE: "%4" };
    const childEnv = stripTmuxEnv(env);

    assert.deepEqual(childEnv, { PATH: "/usr/bin", TMUX_PANE: "%4" });
    assert.equal(env.TMUX, "/tmp/tmux/default,123,0");
  });
});
