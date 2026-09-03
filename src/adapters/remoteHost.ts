import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SwarmError } from "../core/errors.ts";
import type { RemoteHostPort, Shell } from "../core/ports.ts";
import { quotePosixArg } from "../core/remote.ts";
import type { HostConfigEntry, HostId } from "../core/types.ts";

export { quotePosixArg, sshInteractiveCommand } from "../core/remote.ts";

type ResolvedHost = HostConfigEntry & { id: HostId };

function remoteCommand(host: HostConfigEntry, args: string[]): string {
  const suffix = args.map(quotePosixArg).join(" ");
  return suffix.length > 0 ? `${host.swarmCommand} ${suffix}` : host.swarmCommand;
}

export function sshArgv(host: ResolvedHost, args: string[], swarmHome: string): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${join(swarmHome, "cache", "ssh", "%C")}`,
    "-o",
    "ControlPersist=120",
    "--",
    host.ssh,
    remoteCommand(host, args),
  ];
}

export function createRemoteHost(
  shell: Shell,
  swarmHome: string,
  sshCommand = "ssh",
): RemoteHostPort {
  const cacheDir = join(swarmHome, "cache", "ssh");
  let prepareCache: Promise<void> | undefined;

  const ensureCache = (): Promise<void> => {
    if (prepareCache) return prepareCache;
    prepareCache = mkdir(cacheDir, { recursive: true, mode: 0o700 })
      .then(() => chmod(cacheDir, 0o700))
      .catch((error: unknown) => {
        prepareCache = undefined;
        throw error;
      });
    return prepareCache;
  };

  return {
    async run(host, args, opts) {
      await ensureCache();
      const result = await shell.run(sshCommand, sshArgv(host, args, swarmHome), {
        timeoutMs: opts?.timeoutMs,
      });
      if (opts?.timeoutMs !== undefined && result.code === 124) {
        throw new SwarmError(
          "remote",
          `${host.id}: remote command timed out after ${opts.timeoutMs}ms`,
        );
      }
      return result;
    },
  };
}
