import { SwarmError } from "../core/errors.ts";
import type { AgentName } from "../core/types.ts";

export { AGENT_NAMES, type AgentName, isAgentName } from "../core/types.ts";

export function agentSessionName(agent: AgentName): string {
  return `swarm-agent-${agent}`;
}

export function agentCommandArgv(agent: AgentName): string[] {
  return [agent];
}

export function parseTmuxSocket(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(.*),\d+,\d+$/u.exec(value);
  const socket = match?.[1];
  if (!socket) {
    throw new SwarmError(
      "tmux",
      "Invalid TMUX environment value; expected socket_path,pid,session_index",
    );
  }
  return socket;
}

export function tmuxAttachArgv(session: string, tmux: string | undefined): string[] {
  const socket = parseTmuxSocket(tmux);
  return [...(socket ? ["-S", socket] : []), "attach-session", "-t", session];
}

export function stripTmuxEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  delete childEnv.TMUX;
  return childEnv;
}
