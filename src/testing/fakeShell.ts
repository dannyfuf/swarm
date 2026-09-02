import { SwarmError } from "../core/errors.ts";
import type { RunOptions, Shell, ShellResult } from "../core/ports.ts";

export interface FakeShellRule {
  match: (cmd: string, args: string[]) => boolean;
  result:
    | Partial<ShellResult>
    | ((cmd: string, args: string[], opts?: RunOptions) => Partial<ShellResult>);
}

export interface FakeShellCall {
  cmd: string;
  args: string[];
  opts?: RunOptions | { cwd?: string };
}

export type FakeShell = Shell & {
  calls: FakeShellCall[];
  detachedCalls: FakeShellCall[];
};

export function createFakeShell(rules: FakeShellRule[] = []): FakeShell {
  const calls: FakeShellCall[] = [];
  const detachedCalls: FakeShellCall[] = [];

  return {
    calls,
    detachedCalls,
    async run(cmd, args, opts) {
      calls.push({ cmd, args: [...args], opts });
      const rule = rules.find((candidate) => candidate.match(cmd, args));
      if (!rule) return { code: 127, stdout: "", stderr: "fake: no rule" };
      const partial =
        typeof rule.result === "function" ? rule.result(cmd, args, opts) : rule.result;
      return { code: 0, stdout: "", stderr: "", ...partial };
    },
    async spawnDetached(cmd, args, opts) {
      const call = { cmd, args: [...args], opts };
      calls.push(call);
      detachedCalls.push(call);
    },
    async exec(cmd, args): Promise<never> {
      calls.push({ cmd, args: [...args] });
      throw new SwarmError("unsupported", "FakeShell cannot replace the current process");
    },
  };
}
