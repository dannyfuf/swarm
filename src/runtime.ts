import { join } from "node:path";
import { createClipboard } from "./adapters/clipboard.ts";
import { createConfigStore } from "./adapters/config.ts";
import { createFiles } from "./adapters/files.ts";
import { createGit } from "./adapters/git.ts";
import { createGithub } from "./adapters/github.ts";
import { createLogger } from "./adapters/logger.ts";
import { createProcess } from "./adapters/process.ts";
import { createShell } from "./adapters/shell.ts";
import { createStateStore } from "./adapters/state.ts";
import { createTmux } from "./adapters/tmux.ts";
import { createController } from "./app/controller.ts";
import { createStore } from "./app/store.ts";
import { swarmHome } from "./core/paths.ts";
import type { Clock, Logger } from "./core/ports.ts";
import { noStartupTiming, type StartupTiming } from "./core/startup.ts";
import type { Config } from "./core/types.ts";
import { createContextService } from "./services/contexts.ts";
import { createPrService } from "./services/prs.ts";
import { createRepoService } from "./services/repos.ts";
import { createSessionService } from "./services/sessions.ts";
import { createStatusService } from "./services/status.ts";
import { createWorktreeService } from "./services/worktrees.ts";

export interface Runtime {
  home: string;
  configValue: Config;
  logger: Logger;
  state: ReturnType<typeof createStateStore>;
  tmux: ReturnType<typeof createTmux>;
  sessions: ReturnType<typeof createSessionService>;
  controller: ReturnType<typeof createController>;
  store: ReturnType<typeof createStore>;
}

export async function createRuntime(
  env: NodeJS.ProcessEnv,
  startup: StartupTiming = noStartupTiming,
): Promise<Runtime> {
  const home = swarmHome(env);
  const logsDir = join(home, "logs");
  const githubCacheDir = join(home, "cache", "github");
  const logger = createLogger(join(logsDir, "swarm.log"), "main");
  const shell = createShell(logger, startup);
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

  await startup.measure("runtime.bootstrapDirectories", () =>
    Promise.all(
      [home, logsDir, githubCacheDir, join(home, "trash")].map((path) => files.ensureDir(path)),
    ).then(() => undefined),
  );

  const config = createConfigStore(
    files,
    join(home, "config.json"),
    home,
    logger,
    env.HOME ?? home,
  );
  const configValue = await startup.measure("runtime.configLoad", () => config.load());
  removalRoots.push(configValue.reposDir, configValue.worktreesDir);
  await startup.measure("runtime.configuredDirectories", () =>
    Promise.all(
      [configValue.reposDir, configValue.worktreesDir].map((path) => files.ensureDir(path)),
    ).then(() => undefined),
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
    startup,
  });

  return { home, configValue, logger, state, tmux, sessions, controller, store };
}
