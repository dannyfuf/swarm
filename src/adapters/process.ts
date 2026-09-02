import { SwarmError } from "../core/errors.ts";
import type { ProcessPort, ProcInfo, Shell, ShellResult } from "../core/ports.ts";

function commandFailure(command: string, result: ShellResult): SwarmError {
  const detail = result.stderr.trim() || result.stdout.trim() || "no error output";
  return new SwarmError(
    "unsupported",
    `${command} failed with exit code ${result.code}: ${detail}`,
    { cause: result },
  );
}

export function createProcess(shell: Shell, platform: NodeJS.Platform): ProcessPort {
  void platform;

  return {
    async snapshot() {
      let result: ShellResult;
      try {
        result = await shell.run("ps", ["-axo", "pid=,ppid=,command="]);
      } catch (cause) {
        throw new SwarmError("unsupported", "ps could not be run", { cause });
      }
      if (result.code !== 0) throw commandFailure("ps", result);

      const snapshot: ProcInfo[] = [];
      for (const line of result.stdout.split("\n")) {
        if (!line.trim()) continue;
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (!match) continue;
        const [, pidText, ppidText, command] = match;
        if (pidText === undefined || ppidText === undefined || command === undefined) continue;
        snapshot.push({ pid: Number(pidText), ppid: Number(ppidText), command });
      }
      return snapshot;
    },

    descendants(root, snapshot) {
      const childrenByParent = new Map<number, ProcInfo[]>();
      for (const entry of snapshot) {
        const children = childrenByParent.get(entry.ppid) ?? [];
        children.push(entry);
        childrenByParent.set(entry.ppid, children);
      }

      const rootProcess = snapshot.find(({ pid }) => pid === root);
      const result = rootProcess ? [rootProcess] : [];
      const queue = [root];
      const seen = new Set(queue);
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const parent = queue[cursor];
        if (parent === undefined) continue;
        for (const child of childrenByParent.get(parent) ?? []) {
          if (seen.has(child.pid)) continue;
          seen.add(child.pid);
          queue.push(child.pid);
          result.push(child);
        }
      }
      return result;
    },

    async listeningPorts(pids) {
      if (pids.length === 0) return new Map();
      const args = ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pids.join(","), "-F", "pn"];

      let result: ShellResult;
      try {
        result = await shell.run("lsof", args);
      } catch (cause) {
        throw new SwarmError("unsupported", "lsof could not be run", { cause });
      }
      if (result.code === 1 && result.stdout.trim() === "") return new Map();
      if (result.code !== 0) throw commandFailure("lsof", result);

      const requested = new Set(pids);
      const portsByPid = new Map<number, Set<number>>();
      let currentPid: number | undefined;
      for (const line of result.stdout.split("\n")) {
        if (line.startsWith("p")) {
          const pid = Number(line.slice(1));
          currentPid = Number.isInteger(pid) && requested.has(pid) ? pid : undefined;
          continue;
        }
        if (!line.startsWith("n") || currentPid === undefined) continue;
        const address = line.slice(1);
        const separator = address.lastIndexOf(":");
        const port = Number(address.slice(separator + 1));
        if (separator < 0 || !Number.isInteger(port)) continue;
        const ports = portsByPid.get(currentPid) ?? new Set<number>();
        ports.add(port);
        portsByPid.set(currentPid, ports);
      }

      return new Map([...portsByPid].map(([pid, ports]) => [pid, [...ports]]));
    },

    async isAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EPERM"
        ) {
          return true;
        }
        return false;
      }
    },
  };
}
