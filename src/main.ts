import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClipboard } from "./adapters/clipboard.ts";
import { createConfigStore } from "./adapters/config.ts";
import { createFiles } from "./adapters/files.ts";
import { createGit } from "./adapters/git.ts";
import { createGithub } from "./adapters/github.ts";
import { createLogger, createNullLogger } from "./adapters/logger.ts";
import { createProcess } from "./adapters/process.ts";
import { createShell } from "./adapters/shell.ts";
import { createStateStore } from "./adapters/state.ts";
import { createTmux } from "./adapters/tmux.ts";
import { createController } from "./app/controller.ts";
import { createStore } from "./app/store.ts";
import { SwarmError } from "./core/errors.ts";
import { swarmHome } from "./core/paths.ts";
import type { Clock, Logger, Shell, ShellResult } from "./core/ports.ts";
import type { UnmountReport } from "./core/services.ts";
import type { Config, State, Worktree } from "./core/types.ts";
import { createContextService } from "./services/contexts.ts";
import { createPrService } from "./services/prs.ts";
import { createRepoService } from "./services/repos.ts";
import { createSessionService } from "./services/sessions.ts";
import { createStatusService } from "./services/status.ts";
import { createWorktreeService } from "./services/worktrees.ts";

export const VERSION = "0.1.0";

export type CliCommand =
  | { kind: "tui" }
  | { kind: "open"; target: string }
  | { kind: "sleep"; session?: string }
  | { kind: "doctor" }
  | { kind: "version" }
  | { kind: "help" };

interface Runtime {
  home: string;
  configValue: Config;
  logger: Logger;
  state: ReturnType<typeof createStateStore>;
  tmux: ReturnType<typeof createTmux>;
  sessions: ReturnType<typeof createSessionService>;
  controller: ReturnType<typeof createController>;
  store: ReturnType<typeof createStore>;
}

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  hint: string;
}

const USAGE =
  "Usage: swarm [open <owner/name#slug|repo/slug> | sleep [session] | doctor | --version]";

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
  if (command === "sleep" && args.length <= 1) {
    return args[0] ? { kind: "sleep", session: args[0] } : { kind: "sleep" };
  }
  throw new SwarmError("validation", USAGE);
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

async function createRuntime(env: NodeJS.ProcessEnv): Promise<Runtime> {
  const home = swarmHome(env);
  const logsDir = join(home, "logs");
  const githubCacheDir = join(home, "cache", "github");
  const logger = createLogger(join(logsDir, "swarm.log"), "main");
  const shell = createShell(logger);
  const processPort = createProcess(shell, process.platform);
  const clock: Clock = {
    now: () => new Date(),
    setInterval(callback, intervalMs) {
      return globalThis.setInterval(callback, intervalMs);
    },
    clearInterval(handle) {
      globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>);
    },
  };
  const removalRoots = [join(home, "trash")];
  const files = createFiles(shell, logger, process.platform, removalRoots);

  await Promise.all(
    [home, logsDir, githubCacheDir, join(home, "trash")].map((path) => files.ensureDir(path)),
  );

  const config = createConfigStore(
    files,
    join(home, "config.json"),
    home,
    logger,
    env.HOME ?? home,
  );
  const configValue = await config.load();
  removalRoots.push(configValue.reposDir, configValue.worktreesDir);
  await Promise.all(
    [configValue.reposDir, configValue.worktreesDir].map((path) => files.ensureDir(path)),
  );

  const state = createStateStore(files, join(home, "state.json"), logger, {
    process: processPort,
  });
  const git = createGit(shell, logger);
  const tmux = createTmux(shell, logger, env);
  const github = createGithub(shell, files, logger, {
    cacheDir: githubCacheDir,
    cacheTtlSeconds: configValue.github.cacheTtlSeconds,
    clock,
  });
  const clipboard = createClipboard(shell, process.platform);
  const worktrees = createWorktreeService({
    state,
    config,
    git,
    files,
    tmux,
    shell,
    clock,
    logger,
    home,
  });
  const repos = createRepoService({
    state,
    config,
    github,
    git,
    process: processPort,
    files,
    worktreeService: worktrees,
    clock,
    logger,
    home,
  });
  const contexts = createContextService({ state, clock, repoService: repos });
  const prs = createPrService({ github, ttlSeconds: configValue.github.prTtlSeconds });
  const sessions = createSessionService({
    tmux,
    process: processPort,
    config,
    state,
    worktrees,
    clock,
    logger,
  });
  const status = createStatusService({
    tmux,
    process: processPort,
    config,
    logger,
  });
  const store = createStore({ config: configValue });
  const controller = createController({
    store,
    contexts,
    repos,
    prs,
    worktrees,
    sessions,
    status,
    config,
    state,
    tmux,
    clipboard,
    process: processPort,
    clock,
    logger,
  });

  return { home, configValue, logger, state, tmux, sessions, controller, store };
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

  if (command.kind === "tui") {
    try {
      await runtime.controller.init();
      const { runTui } = await import("./ui/App.tsx");
      await runTui({
        store: runtime.store,
        controller: runtime.controller,
        config: runtime.configValue,
        home: process.env.HOME ?? runtime.home,
      });
    } finally {
      runtime.controller.dispose();
    }
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let runtime: Runtime | undefined;
  try {
    const command = parseArgv(argv);
    if (command.kind === "version") {
      process.stdout.write(`swarm ${VERSION}\n`);
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

    runtime = await createRuntime(process.env);
    await runRuntimeCommand(runtime, command);
    return 0;
  } catch (error) {
    runtime?.logger.error("Fatal error", errorLogData(error));
    process.stderr.write(`swarm: ${errorMessage(error)}\n`);
    return 1;
  }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = await main();
}
