import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CLI_VERSION,
  handleProtocolCommand,
  humanProtocolResponse,
  isProtocolCommand,
  PROTOCOL_VERSION,
  type ProtocolCommand,
  protocolErrorEnvelope,
} from "./cli/protocol.ts";
import { SwarmError } from "./core/errors.ts";
import { isWorktreeSlug, proxySessionName } from "./core/paths.ts";
import type { RemoteHostPort, Shell, ShellResult } from "./core/ports.ts";
import { validateBranch } from "./core/prs.ts";
import type { UnmountReport } from "./core/services.ts";
import { createStartupProfiler } from "./core/startup.ts";
import {
  agentCommand,
  type Config,
  HostId,
  type RepoHooks,
  RepoHooksSchema,
  RepoId,
  type State,
  type Worktree,
  WorktreeId,
  worktreeHost,
} from "./core/types.ts";
import { VERSION } from "./core/version.ts";
import type { Runtime } from "./runtime.ts";
import {
  type AgentName,
  agentCommandArgv,
  agentSessionName,
  isAgentName,
  stripTmuxEnv,
  tmuxAttachArgv,
} from "./services/agentPopup.ts";

export { VERSION };

const startupProfiler = createStartupProfiler(process.env.SWARM_STARTUP_PROFILE);
startupProfiler.mark("main.moduleLoaded");

export type CliCommand =
  | { kind: "tui" }
  | { kind: "open"; target: string }
  | { kind: "sleep"; session?: string; json?: true }
  | { kind: "agent"; agent?: AgentName }
  | { kind: "doctor" }
  | { kind: "version" }
  | { kind: "path"; worktreeId: Worktree["id"] }
  | { kind: "help"; command?: CommandName }
  | ProtocolCommand;

export type CommandName =
  | "open"
  | "sleep"
  | "agent"
  | "list"
  | "create"
  | "inspect"
  | "delete"
  | "prune"
  | "kill"
  | "status"
  | "path"
  | "doctor";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  hint: string;
}

export interface TuiExitDependencies {
  flushStdout(): Promise<void>;
  flushStderr(): Promise<void>;
  exit(code: number): void;
}

function flushWritable(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise<void>((resolve) => {
    stream.write("", () => resolve());
  });
}

export async function exitTuiProcess(
  code: number,
  deps: TuiExitDependencies = {
    flushStdout: () => flushWritable(process.stdout),
    flushStderr: () => flushWritable(process.stderr),
    exit: (exitCode) => process.exit(exitCode),
  },
): Promise<void> {
  await Promise.all([deps.flushStdout(), deps.flushStderr()]);
  deps.exit(code);
}

export const USAGE = `Usage: swarm [command]

Commands:
  open       Mount and open a worktree
  sleep      Apply the sleep policy to a session
  agent      Open a persistent agent session
  list       List registered repositories and worktrees
  create     Create or return a worktree
  inspect    Inspect Git, PR, and tmux safety facts
  delete     Safely delete one or more worktrees
  prune      Delete every eligible merged worktree
  kill       Hard-kill a worktree session
  status     Show tmux status for local worktrees
  path       Print a local worktree's absolute path
  doctor     Check runtime dependencies and remote hosts
  --version  Print the installed version

Run swarm <command> --help for command details.`;

export const COMMAND_HELP: Record<CommandName, string> = {
  open: `Usage: swarm open <owner/name#slug|repo/slug>

Flags:
  --help  Show this help [default: false]

Output: opens the worktree's tmux session; no JSON envelope.
Remote: remote worktrees open through a local SSH proxy session.`,
  sleep: `Usage: swarm sleep [session] [--json]

Flags:
  --json  Emit {protocol, kept, closed, sessionKilled} [default: false]
  --help  Show this help [default: false]

Default session: the current tmux session.
Remote: recorded remote worktrees are routed to their host.`,
  agent: `Usage: swarm agent [claude|opencode]

Flags:
  --help  Show this help [default: false]

Default agent: config.agent. Output is the attached tmux session; no JSON envelope.
Remote: agent sessions are local only.`,
  list: `Usage: swarm list [--json]

Flags:
  --json  Emit {protocol, version, repos, worktrees} [default: false]
  --help  Show this help [default: false]

Default output: a human-readable count. All JSON paths are absolute.
Remote: mirrored remote worktrees retain their host paths.`,
  create: `Usage: swarm create <owner/name> <slug> [--branch <name>] [--base <ref>] [--host <id>] [--url <url>] [--default-branch <name>] [--hooks <json>] [--json]

Flags:
  --branch <name>         Branch name [default: <slug>]
  --base <ref>            Starting ref [default: origin/<repo default branch>]
  --host <id>             Remote placement [default: local]
  --url <url>             Clone URL for an unregistered repo [default: none]
  --default-branch <name> Clone default-branch hint [default: resolved origin/HEAD]
  --hooks <json>          Repo prepare/postCreate hooks [default: {"prepare":[],"postCreate":[]}]
  --json                  Emit {protocol, created, worktree} [default: false]
  --help                  Show this help [default: false]

Existing ids: only explicitly supplied --branch and --host values must match; hooks do not rerun.
Remote: --host invokes swarm on that host without forwarding --host, and preserves whether --branch was omitted.`,
  inspect: `Usage: swarm inspect [id...] [--fetch] [--repo <owner/name>] [--json]

Flags:
  --fetch               Fetch and prune origin once per repo first [default: false]
  --repo <owner/name>   Restrict repositories [default: all]
  --json                Emit {protocol,worktrees:[{...,head,uniqueCommits,published,merged,pr,...}]} [default: false]
  --help                Show this help [default: false]

Default ids: every worktree. A merged PR counts only when its head contains the inspected local HEAD; otherwise merged requires both mergedIntoTarget and publication.
Remote worktrees are inspected on their recorded host; offline hosts produce per-worktree errors.`,
  delete: `Usage: swarm delete <id>... [--force] [--json]

Flags:
  --force  Delete despite Git, tmux-session, or running-command safety facts [default: false]
  --json   Emit {protocol, ok, results:[{worktreeId,ok,reason?}]} [default: false]
  --help   Show this help [default: false]

Safety: without --force, dirty, attached, unknown-session, or running worktrees are refused. An unmerged worktree is also refused when uniqueCommits is positive; when the count is unavailable the reason is "cannot determine unique commits". A clean, idle fresh worktree with zero unique commits is allowed.
Remote: each remote worktree is rechecked and deleted on its recorded host.`,
  prune: `Usage: swarm prune [--dry-run] [--no-fetch] [--kill-sessions] [--repo <owner/name>] [--json]

Flags:
  --dry-run             Select without deleting [default: false]
  --no-fetch            Skip the default fetch and prune [default: false]
  --kill-sessions       Delete eligible detached sessions even when commands are running [default: false]
  --repo <owner/name>   Restrict repositories [default: all]
  --json                Emit {protocol,dryRun,deleted,skipped:[{worktreeId,reason,merged,dirty,uniqueCommits,running}]} [default: false]
  --help                Show this help [default: false]

Eligibility: clean, known session state, and merged:true. By default, running commands are skipped. --kill-sessions requires a known unique-commit count and permits running commands only in detached sessions (or no session); attached and unknown sessions remain protected.
Remote: remote worktrees are inspected and deleted on their recorded hosts; --kill-sessions uses the remote forced-delete path after local safety checks.`,
  kill: `Usage: swarm kill <owner/name#slug> [--json]

Flags:
  --json  Emit {protocol, ok:true} [default: false]
  --help  Show this help [default: false]

Remote: recorded remote worktrees are routed to their host.`,
  status: `Usage: swarm status [--json]

Flags:
  --json  Emit {protocol, statuses} [default: false]
  --help  Show this help [default: false]

Default output: one worktree and session state per line. Remote mirrors are omitted; their host serves status.`,
  path: `Usage: swarm path <owner/name#slug>

Flags:
  --help  Show this help [default: false]

Output: the absolute local path as plain text. Remote worktrees are refused.`,
  doctor: `Usage: swarm doctor

Flags:
  --help  Show this help [default: false]

Output: dependency and configured-host checks as plain text.`,
};

function validation(message: string = USAGE): never {
  throw new SwarmError("validation", message);
}

function takeJsonFlag(args: string[]): { args: string[]; json: boolean } {
  const jsonFlags = args.filter((arg) => arg === "--json").length;
  if (jsonFlags > 1) validation("--json may only be specified once");
  return { args: args.filter((arg) => arg !== "--json"), json: jsonFlags === 1 };
}

function parseId<T>(
  value: string | undefined,
  schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } },
  label: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) validation(`Invalid ${label}: ${value ?? "<missing>"}`);
  return parsed.data;
}

function parseHooks(value: string | undefined): RepoHooks {
  if (value === undefined) return { prepare: [], postCreate: [] };
  try {
    return RepoHooksSchema.strict().parse(JSON.parse(value));
  } catch (cause) {
    throw new SwarmError(
      "validation",
      "--hooks must be a JSON object with string-array prepare and postCreate fields",
      {
        cause,
      },
    );
  }
}

function parseCreate(args: string[], json: boolean): ProtocolCommand {
  const positional: string[] = [];
  const options = new Map<string, string>();
  const supported = new Set([
    "--branch",
    "--base",
    "--host",
    "--url",
    "--default-branch",
    "--hooks",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) validation();
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (!supported.has(arg) || options.has(arg)) validation(`Invalid or duplicate option: ${arg}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) validation(`Missing value for ${arg}`);
    options.set(arg, value);
    index += 1;
  }
  if (positional.length !== 2) validation();
  const repoId = parseId(positional[0], RepoId, "repository id");
  const slug = positional[1];
  const branch = options.get("--branch");
  const baseRef = options.get("--base");
  if (!slug) validation();
  if (!isWorktreeSlug(slug)) validation(`Invalid worktree slug: ${slug}`);
  if (branch) validateBranch(branch);
  return {
    kind: "create",
    repoId,
    slug,
    ...(branch ? { branch } : {}),
    ...(baseRef ? { baseRef } : {}),
    ...(options.has("--host") ? { host: parseId(options.get("--host"), HostId, "host id") } : {}),
    url: options.get("--url"),
    defaultBranch: options.get("--default-branch"),
    hooks: parseHooks(options.get("--hooks")),
    json,
  };
}

function parseInspect(args: string[], json: boolean): ProtocolCommand {
  const worktreeIds: Worktree["id"][] = [];
  let fetch = false;
  let repoId: ReturnType<typeof RepoId.parse> | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) validation();
    if (arg === "--fetch") {
      if (fetch) validation("--fetch may only be specified once");
      fetch = true;
      continue;
    }
    if (arg === "--repo") {
      if (repoId) validation("--repo may only be specified once");
      repoId = parseId(args[index + 1], RepoId, "repository id");
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) validation(`Invalid option: ${arg}`);
    worktreeIds.push(parseId(arg, WorktreeId, "worktree id"));
  }
  return { kind: "inspect", worktreeIds, fetch, ...(repoId ? { repoId } : {}), json };
}

function parsePrune(args: string[], json: boolean): ProtocolCommand {
  let dryRun = false;
  let noFetch = false;
  let killSessions = false;
  let repoId: ReturnType<typeof RepoId.parse> | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      if (dryRun) validation("--dry-run may only be specified once");
      dryRun = true;
      continue;
    }
    if (arg === "--no-fetch") {
      if (noFetch) validation("--no-fetch may only be specified once");
      noFetch = true;
      continue;
    }
    if (arg === "--kill-sessions") {
      if (killSessions) validation("--kill-sessions may only be specified once");
      killSessions = true;
      continue;
    }
    if (arg === "--repo") {
      if (repoId) validation("--repo may only be specified once");
      repoId = parseId(args[index + 1], RepoId, "repository id");
      index += 1;
      continue;
    }
    validation(`Invalid option: ${arg ?? "<missing>"}`);
  }
  return {
    kind: "prune",
    dryRun,
    noFetch,
    killSessions,
    ...(repoId ? { repoId } : {}),
    json,
  };
}

export function parseArgv(argv: string[]): CliCommand {
  const [command, ...args] = argv;
  if (command === undefined) return { kind: "tui" };
  if ((command === "--version" || command === "-v") && args.length === 0) {
    return { kind: "version" };
  }
  if ((command === "--help" || command === "-h") && args.length === 0) {
    return { kind: "help" };
  }
  const commandNames = new Set<CommandName>(Object.keys(COMMAND_HELP) as CommandName[]);
  if (
    commandNames.has(command as CommandName) &&
    args.length === 1 &&
    (args[0] === "--help" || args[0] === "-h")
  ) {
    return { kind: "help", command: command as CommandName };
  }
  if (command === "doctor" && args.length === 0) return { kind: "doctor" };
  if (command === "open" && args.length === 1 && args[0]) {
    return { kind: "open", target: args[0] };
  }
  if (command === "sleep") {
    const parsed = takeJsonFlag(args);
    if (parsed.args.length <= 1) {
      return parsed.args[0]
        ? {
            kind: "sleep",
            session: parsed.args[0],
            ...(parsed.json ? { json: true as const } : {}),
          }
        : { kind: "sleep", ...(parsed.json ? { json: true as const } : {}) };
    }
  }
  if (command === "agent" && args.length <= 1) {
    if (args.length === 0) return { kind: "agent" };
    if (isAgentName(args[0])) return { kind: "agent", agent: args[0] };
  }
  if (command === "path" && args.length === 1) {
    return { kind: "path", worktreeId: parseId(args[0], WorktreeId, "worktree id") };
  }
  if (
    command === "list" ||
    command === "create" ||
    command === "delete" ||
    command === "kill" ||
    command === "status" ||
    command === "inspect" ||
    command === "prune"
  ) {
    const parsed = takeJsonFlag(args);
    if (command === "create") return parseCreate(parsed.args, parsed.json);
    if (command === "inspect") return parseInspect(parsed.args, parsed.json);
    if (command === "prune") return parsePrune(parsed.args, parsed.json);
    if (command === "list" || command === "status") {
      if (parsed.args.length > 0) validation();
      return { kind: command, json: parsed.json };
    }
    if (command === "delete") {
      const forceFlags = parsed.args.filter((arg) => arg === "--force").length;
      if (forceFlags > 1) validation("--force may only be specified once");
      const ids = parsed.args.filter((arg) => arg !== "--force");
      if (ids.length === 0 || ids.some((arg) => arg.startsWith("--"))) validation();
      return {
        kind: "delete",
        worktreeIds: ids.map((id) => parseId(id, WorktreeId, "worktree id")),
        force: forceFlags === 1,
        json: parsed.json,
      };
    }
    if (parsed.args.length !== 1) validation();
    return {
      kind: command,
      worktreeId: parseId(parsed.args[0], WorktreeId, "worktree id"),
      json: parsed.json,
    };
  }
  throw new SwarmError("validation", USAGE);
}

export function resolveAgentName(
  override: AgentName | undefined,
  configured: AgentName,
): AgentName {
  return override ?? configured;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").trim() || "Unknown error";
}

function errorLogData(error: unknown): unknown {
  if (!(error instanceof Error)) return { value: error };
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: error.cause,
    ...(error instanceof SwarmError ? { code: error.code } : {}),
  };
}

export function findWorktree(state: State, target: string): Worktree {
  const worktree = state.worktrees.find(
    (candidate) =>
      candidate.id === target ||
      candidate.session === target ||
      (worktreeHost(candidate) !== "local" &&
        proxySessionName(worktreeHost(candidate), candidate.session) === target),
  );
  if (!worktree) throw new SwarmError("not-found", `Worktree not found: ${target}`);
  return worktree;
}

export function localWorktreePath(worktree: Worktree): string {
  if (worktreeHost(worktree) !== "local") {
    throw new SwarmError(
      "unsupported",
      `Worktree ${worktree.id} is remote on ${worktreeHost(worktree)}`,
    );
  }
  return resolve(worktree.path);
}

export function formatUnmountReport(report: UnmountReport): string {
  return JSON.stringify(report, null, 2);
}

function versionAtLeast(version: string, minimumMajor: number, minimumMinor: number): boolean {
  const match = /^(\d+)\.(\d+)/u.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > minimumMajor || (major === minimumMajor && minor >= minimumMinor);
}

async function safeRun(shell: Shell, cmd: string, args: string[]): Promise<ShellResult> {
  try {
    return await shell.run(cmd, args, { timeoutMs: 5000 });
  } catch (error) {
    return { code: 1, stdout: "", stderr: errorMessage(error) };
  }
}

export async function doctorChecks(
  options: { shell?: Shell; config?: Config; remoteHost?: RemoteHostPort } = {},
): Promise<DoctorCheck[]> {
  let shell = options.shell;
  if (!shell) {
    const [{ createShell }, { createNullLogger }] = await Promise.all([
      import("./adapters/shell.ts"),
      import("./adapters/logger.ts"),
    ]);
    shell = createShell(createNullLogger());
  }
  const [tmux, git, gh, cloneCopy] = await Promise.all([
    safeRun(shell, "tmux", ["-V"]),
    safeRun(shell, "git", ["--version"]),
    safeRun(shell, "gh", ["auth", "status"]),
    process.platform === "darwin" ? safeRun(shell, "cp", ["-c"]) : safeRun(shell, "cp", ["--help"]),
  ]);
  const tmuxVersion = /tmux\s+(\d+\.\d+)/u.exec(tmux.stdout)?.[1];
  const cpOutput = `${cloneCopy.stdout}\n${cloneCopy.stderr}`;
  const cloneCopyOk =
    process.platform === "darwin"
      ? !/(?:illegal|invalid|unknown) option[^\n]*c/iu.test(cpOutput)
      : cloneCopy.code === 0 && cpOutput.includes("--reflink");

  const checks: DoctorCheck[] = [
    {
      name: "node >= 26.4",
      ok: versionAtLeast(process.versions.node, 26, 4),
      detail: `v${process.versions.node}`,
      hint: "Install Node 26.4 or newer; .nvmrc pins the supported runtime.",
    },
    {
      name: "tmux >= 3.2",
      ok: tmux.code === 0 && tmuxVersion !== undefined && versionAtLeast(tmuxVersion, 3, 2),
      detail: tmux.stdout.trim() || tmux.stderr.trim() || "not found",
      hint: "Install tmux 3.2 or newer and ensure it is on PATH.",
    },
    {
      name: "git",
      ok: git.code === 0,
      detail: git.stdout.trim() || git.stderr.trim() || "not found",
      hint: "Install Git and ensure it is on PATH.",
    },
    {
      name: "gh auth",
      ok: gh.code === 0,
      detail: gh.code === 0 ? "authenticated" : gh.stderr.trim() || "not authenticated",
      hint: "Run `gh auth login` and authorize access to the required owners.",
    },
    {
      name: process.platform === "darwin" ? "cp -c" : "cp --reflink",
      ok: cloneCopyOk,
      detail: cloneCopyOk ? "supported" : "not supported",
      hint:
        process.platform === "darwin"
          ? "Use a macOS `cp` implementation with clonefile (`-c`) support."
          : "Install GNU coreutils with `cp --reflink=auto` support.",
    },
  ];

  for (const [hostId, entry] of Object.entries(options.config?.hosts ?? {})) {
    const ssh = await safeRun(shell, "ssh", [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      "--",
      entry.ssh,
      "true",
    ]);
    checks.push({
      name: `host ${hostId}: ssh`,
      ok: ssh.code === 0,
      detail: ssh.code === 0 ? "reachable" : ssh.stderr.trim() || ssh.stdout.trim() || "failed",
      hint: "load your SSH key or fix the alias",
    });

    let swarmResult: ShellResult;
    try {
      swarmResult = options.remoteHost
        ? await options.remoteHost.run({ id: hostId, ...entry }, ["list", "--json"], {
            timeoutMs: 5000,
          })
        : { code: 1, stdout: "", stderr: "remote transport unavailable" };
    } catch (error) {
      swarmResult = { code: 1, stdout: "", stderr: errorMessage(error) };
    }
    let swarmOk = false;
    let swarmDetail = swarmResult.stderr.trim() || swarmResult.stdout.trim() || "failed";
    if (swarmResult.code === 0) {
      try {
        const envelope = JSON.parse(swarmResult.stdout) as {
          protocol?: unknown;
          version?: unknown;
        };
        const protocolOk = envelope.protocol === PROTOCOL_VERSION;
        swarmOk = protocolOk && typeof envelope.version === "string";
        swarmDetail = `${typeof envelope.version === "string" ? envelope.version : "unknown version"}; protocol ${String(envelope.protocol ?? "missing")}`;
        if (!protocolOk) {
          swarmDetail += ` (expected ${PROTOCOL_VERSION})`;
        }
      } catch {
        swarmDetail = "invalid JSON response";
      }
    }
    checks.push({
      name: `host ${hostId}: swarm`,
      ok: swarmOk,
      detail: swarmDetail,
      hint: `install swarm on the host and make sure ${entry.swarmCommand} resolves in a non-interactive shell`,
    });
  }

  return checks;
}

function printDoctor(checks: DoctorCheck[]): void {
  process.stdout.write("CHECK          STATUS  DETAIL\n");
  for (const check of checks) {
    const status = check.ok ? "✓" : "✗";
    process.stdout.write(`${check.name.padEnd(14)} ${status.padEnd(7)} ${check.detail}\n`);
    if (!check.ok) process.stdout.write(`${"".padEnd(24)}${check.hint}\n`);
  }
}

async function runRuntimeCommand(runtime: Runtime, command: CliCommand): Promise<void> {
  if (command.kind === "path") {
    const worktree = findWorktree(await runtime.state.load(), command.worktreeId);
    process.stdout.write(`${localWorktreePath(worktree)}\n`);
    return;
  }

  if (command.kind === "open") {
    const worktree = findWorktree(await runtime.state.load(), command.target);
    await runtime.sessions.open(worktree);
    return;
  }

  if (command.kind === "sleep") {
    const session = command.session ?? (await runtime.tmux.currentSession());
    if (!session) throw new SwarmError("not-found", "No current swarm session");
    const worktree = findWorktree(await runtime.state.load(), session);
    const report = await runtime.sessions.unmount(worktree);
    process.stdout.write(
      `${command.json ? JSON.stringify({ protocol: PROTOCOL_VERSION, ...report }) : formatUnmountReport(report)}\n`,
    );
    return;
  }
}

async function attachAgentSession(session: string, env: NodeJS.ProcessEnv): Promise<number> {
  const args = tmuxAttachArgv(session, env.TMUX);
  return await new Promise<number>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("tmux", args, { env: stripTmuxEnv(env), stdio: "inherit" });
    } catch (cause) {
      reject(
        new SwarmError("tmux", "tmux is required to open an agent popup but could not be run", {
          cause,
        }),
      );
      return;
    }
    child.once("error", (cause) => {
      reject(
        new SwarmError("tmux", "tmux is required to open an agent popup but could not be run", {
          cause,
        }),
      );
    });
    child.once("close", (code) => resolve(code ?? 1));
  });
}

export async function runAgentCommand(
  runtime: Pick<Runtime, "configValue" | "tmux">,
  agent: AgentName,
  env: NodeJS.ProcessEnv,
  attach: typeof attachAgentSession = attachAgentSession,
): Promise<number> {
  const session = agentSessionName(agent);
  let exists: boolean;
  try {
    exists = await runtime.tmux.hasSession(session);
  } catch (cause) {
    throw new SwarmError("tmux", "tmux is required to open an agent popup but could not be run", {
      cause,
    });
  }
  if (!exists) {
    await runtime.tmux.newSession({
      name: session,
      cwd: runtime.configValue.reposDir,
      windowName: agent,
    });
    const windows = await runtime.tmux.listWindows(session);
    const firstIndex = Math.min(...windows.map(({ index }) => index));
    await runtime.tmux.sendKeys(
      `=${session}:${firstIndex}`,
      agentCommandArgv(agentCommand(runtime.configValue, agent)),
      { enter: true },
    );
  }
  return await attach(session, env);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let runtime: Runtime | undefined;
  try {
    const command = parseArgv(argv);
    if (command.kind === "version") {
      process.stdout.write(`${CLI_VERSION}\n`);
      return 0;
    }
    if (command.kind === "help") {
      process.stdout.write(`${command.command ? COMMAND_HELP[command.command] : USAGE}\n`);
      return 0;
    }
    if (command.kind === "doctor") {
      const { createRuntime } = await import("./runtime.ts");
      const createdRuntime = await createRuntime(process.env, startupProfiler);
      runtime = createdRuntime;
      const checks = await doctorChecks({
        shell: createdRuntime.shell,
        config: createdRuntime.configValue,
        remoteHost: createdRuntime.remoteHost,
      });
      printDoctor(checks);
      return checks.every(({ ok }) => ok) ? 0 : 1;
    }

    if (command.kind === "tui") {
      try {
        const { runTui } = await startupProfiler.measure(
          "ui.moduleImport",
          () => import("./ui/runTui.tsx"),
        );
        const exitCode = await runTui({
          startup: startupProfiler,
          async load(requestExit) {
            const { createRuntime } = await startupProfiler.measure(
              "runtime.moduleImport",
              () => import("./runtime.ts"),
            );
            const created = await startupProfiler.measure("runtime.create", () =>
              createRuntime(process.env, startupProfiler, { requestExit }),
            );
            startupProfiler.mark("runtime.created");
            runtime = created;
            return {
              store: created.store,
              controller: created.controller,
              config: created.configValue,
              home: process.env.HOME ?? created.home,
              startup: startupProfiler,
              initialize: () =>
                startupProfiler.measure("controller.init", () => created.controller.init()),
            };
          },
        });
        return exitCode;
      } finally {
        runtime?.controller.dispose();
      }
    }

    const { createRuntime } = await startupProfiler.measure(
      "runtime.moduleImport",
      () => import("./runtime.ts"),
    );
    const createdRuntime = await startupProfiler.measure("runtime.create", () =>
      createRuntime(process.env, startupProfiler),
    );
    startupProfiler.mark("runtime.created");
    runtime = createdRuntime;
    if (isProtocolCommand(command)) {
      const response = await handleProtocolCommand(command, createdRuntime);
      const output = command.json
        ? JSON.stringify(response)
        : humanProtocolResponse(command, response);
      process.stdout.write(`${output}\n`);
      return command.kind === "delete" && "ok" in response && !response.ok ? 1 : 0;
    }
    if (command.kind === "agent") {
      return await runAgentCommand(
        createdRuntime,
        resolveAgentName(command.agent, createdRuntime.configValue.agent),
        process.env,
      );
    }
    await runRuntimeCommand(createdRuntime, command);
    return 0;
  } catch (error) {
    runtime?.logger.error("Fatal error", errorLogData(error));
    if (argv.slice(1).includes("--json")) {
      process.stdout.write(`${JSON.stringify(protocolErrorEnvelope(error))}\n`);
    } else {
      process.stderr.write(`swarm: ${errorMessage(error)}\n`);
    }
    return 1;
  } finally {
    startupProfiler.flush();
    await runtime?.logger.flush();
  }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  const argv = process.argv.slice(2);
  const exitCode = await main(argv);
  if (argv.length === 0) await exitTuiProcess(exitCode);
  else process.exitCode = exitCode;
}
