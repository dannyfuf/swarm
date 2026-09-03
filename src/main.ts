import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  CLI_VERSION,
  handleProtocolCommand,
  humanProtocolResponse,
  isProtocolCommand,
  type ProtocolCommand,
  protocolErrorEnvelope,
} from "./cli/protocol.ts";
import { SwarmError } from "./core/errors.ts";
import { isWorktreeSlug } from "./core/paths.ts";
import type { Shell, ShellResult } from "./core/ports.ts";
import { validateBranch } from "./core/prs.ts";
import type { UnmountReport } from "./core/services.ts";
import { createStartupProfiler } from "./core/startup.ts";
import {
  agentCommand,
  type RepoHooks,
  RepoHooksSchema,
  RepoId,
  type State,
  type Worktree,
  WorktreeId,
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
  | { kind: "help" }
  | ProtocolCommand;

interface DoctorCheck {
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
  open <owner/name#slug|repo/slug>
  sleep [session] [--json]
  agent [claude|opencode]
  list [--json]
  create <owner/name> <slug> --branch <name> --base <ref> [--url <url>] [--default-branch <name>] [--hooks <json>] [--json]
  delete <owner/name#slug> [--json]
  kill <owner/name#slug> [--json]
  status [--json]
  doctor
  --version`;

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
  const supported = new Set(["--branch", "--base", "--url", "--default-branch", "--hooks"]);
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
  if (!slug || !branch || !baseRef) validation();
  if (!isWorktreeSlug(slug)) validation(`Invalid worktree slug: ${slug}`);
  validateBranch(branch);
  return {
    kind: "create",
    repoId,
    slug,
    branch,
    baseRef,
    url: options.get("--url"),
    defaultBranch: options.get("--default-branch"),
    hooks: parseHooks(options.get("--hooks")),
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
  if (
    command === "list" ||
    command === "create" ||
    command === "delete" ||
    command === "kill" ||
    command === "status"
  ) {
    const parsed = takeJsonFlag(args);
    if (command === "create") return parseCreate(parsed.args, parsed.json);
    if (command === "list" || command === "status") {
      if (parsed.args.length > 0) validation();
      return { kind: command, json: parsed.json };
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

function findWorktree(state: State, target: string): Worktree {
  const worktree = state.worktrees.find(
    (candidate) => candidate.id === target || candidate.session === target,
  );
  if (!worktree) throw new SwarmError("not-found", `Worktree not found: ${target}`);
  return worktree;
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

async function doctorChecks(): Promise<DoctorCheck[]> {
  const [{ createShell }, { createNullLogger }] = await Promise.all([
    import("./adapters/shell.ts"),
    import("./adapters/logger.ts"),
  ]);
  const shell = createShell(createNullLogger());
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

  return [
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
    process.stdout.write(`${formatUnmountReport(report)}\n`);
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
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (command.kind === "doctor") {
      const checks = await doctorChecks();
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
      return 0;
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
