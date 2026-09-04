import { join } from "node:path";
import type { HostConfigEntry, HostId, WorktreeId } from "./types.ts";

type ResolvedHost = HostConfigEntry & { id: HostId };

export function quotePosixArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * ssh options shared by every connection swarm opens to a host: a bounded
 * connect timeout and a multiplexed control socket under the swarm home so the
 * batch protocol commands and the interactive proxy reuse one connection.
 * BatchMode is deliberately not part of this set; only non-interactive callers
 * add it.
 */
export function sshCommonOptions(swarmHome: string): string[] {
  return [
    "-o",
    "ConnectTimeout=5",
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${join(swarmHome, "cache", "ssh", "%C")}`,
    "-o",
    "ControlPersist=120",
  ];
}

export function sshInteractiveCommand(
  host: ResolvedHost,
  worktreeId: WorktreeId,
  swarmHome: string,
): string {
  const options = sshCommonOptions(swarmHome)
    .map((option) => (option === "-o" ? option : quotePosixArg(option)))
    .join(" ");
  return `ssh -t ${options} -- ${host.ssh} ${host.swarmCommand} open ${quotePosixArg(worktreeId)}`;
}

/**
 * Wraps the pane command of an ssh proxy session so a failed remote open leaves
 * a readable message in the pane instead of an instantly exiting process.
 */
export function sshPaneCommand(sshCommand: string): string {
  const script = `${sshCommand} || { status=$?; printf "\\nswarm: remote open failed (exit %s) - press Enter to close\\n" "$status"; IFS= read -r _; }`;
  return `sh -c ${quotePosixArg(script)}`;
}
