import type { RemoteHostPort, ShellResult } from "../core/ports.ts";

export interface FakeRemoteHostCall {
  hostId: string;
  args: string[];
  timeoutMs?: number;
}

export type FakeRemoteHost = RemoteHostPort & {
  calls: FakeRemoteHostCall[];
  script(hostId: string, subcommand: string, ...responses: ShellResult[]): void;
};

function key(hostId: string, subcommand: string): string {
  return `${hostId}\0${subcommand}`;
}

export function createFakeRemoteHost(
  initial: Record<string, ShellResult | ShellResult[]> = {},
): FakeRemoteHost {
  const scripts = new Map<string, ShellResult[]>();
  for (const [scriptKey, value] of Object.entries(initial)) {
    scripts.set(
      scriptKey,
      (Array.isArray(value) ? value : [value]).map((response) => structuredClone(response)),
    );
  }
  const calls: FakeRemoteHostCall[] = [];

  return {
    calls,
    script(hostId, subcommand, ...responses) {
      scripts.set(
        key(hostId, subcommand),
        responses.map((response) => structuredClone(response)),
      );
    },
    async run(host, args, opts) {
      calls.push({ hostId: host.id, args: [...args], timeoutMs: opts?.timeoutMs });
      const scriptKey = key(host.id, args[0] ?? "");
      const responses = scripts.get(scriptKey);
      const response = responses?.shift();
      if (!response) {
        return { code: 127, stdout: "", stderr: `fake: no response for ${host.id}/${args[0]}` };
      }
      return structuredClone(response);
    },
  };
}
