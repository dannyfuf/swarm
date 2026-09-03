import type { HostConfigEntry, HostId, WorktreeId } from "./types.ts";

type ResolvedHost = HostConfigEntry & { id: HostId };

export function quotePosixArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function sshInteractiveCommand(host: ResolvedHost, worktreeId: WorktreeId): string {
  return `ssh -t -- ${host.ssh} ${host.swarmCommand} open ${quotePosixArg(worktreeId)}`;
}
