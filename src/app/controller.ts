import type { Action, Controller, Operation, Store, Toast } from "../core/app.ts";
import { SwarmError } from "../core/errors.ts";
import { slugify, worktreeId } from "../core/paths.ts";
import type {
  Clipboard,
  Clock,
  ConfigPort,
  LifecyclePort,
  Logger,
  ProcessPort,
  StatePort,
  TmuxPort,
  UpdaterPort,
} from "../core/ports.ts";
import { prLocalBranch, validateBranch } from "../core/prs.ts";
import type {
  ContextService,
  OnEvent,
  PrService,
  RemoteHostService,
  RepoService,
  SessionService,
  StatusService,
  WorktreeService,
} from "../core/services.ts";
import { noStartupTiming, type StartupTiming } from "../core/startup.ts";
import {
  type HostId,
  type PrTab,
  type Repo,
  type State,
  type Worktree,
  type WorktreeId,
  type WorktreeStatus,
  worktreeHost,
} from "../core/types.ts";
import {
  prsInScope,
  prWorktree,
  selectedPr,
  selectedRepo,
  selectedWorktree,
  visibleRepos,
  worktreePr,
} from "./selectors.ts";

export interface ControllerDeps {
  store: Store;
  contexts: ContextService;
  repos: RepoService;
  prs: PrService;
  worktrees: WorktreeService;
  sessions: SessionService;
  status: StatusService;
  remoteHosts?: RemoteHostService;
  config: ConfigPort;
  state: StatePort;
  tmux: TmuxPort;
  clipboard: Clipboard;
  process: ProcessPort;
  clock: Clock;
  logger: Logger;
  updater: UpdaterPort;
  lifecycle: LifecyclePort;
  installRoot: string;
  startup?: StartupTiming;
  enableHotRefreshTimer?: boolean;
}

function stateFields(
  state: State,
): Pick<
  ReturnType<Store["getState"]>,
  "contexts" | "repos" | "clones" | "worktrees" | "activeContextId"
> {
  return {
    contexts: state.contexts,
    repos: state.repos,
    clones: state.clones,
    worktrees: state.worktrees,
    activeContextId: state.activeContextId ?? state.contexts[0]?.id,
  };
}

function statusRecord(
  statuses: Map<WorktreeId, WorktreeStatus>,
): Record<WorktreeId, WorktreeStatus> {
  return Object.fromEntries(statuses) as Record<WorktreeId, WorktreeStatus>;
}

function asSwarmError(error: unknown): SwarmError {
  if (error instanceof SwarmError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new SwarmError("unsupported", message, { cause: error });
}

export function createController(deps: ControllerDeps): Controller {
  const startup = deps.startup ?? noStartupTiming;
  const minimumRefreshMs = 500;
  const cloneRefreshMs = 2_000;
  let currentConfig = deps.store.getState().config;
  let statusInterval: unknown;
  let cloneInterval: unknown;
  let hotRefreshInterval: unknown;
  const remoteStatusIntervals = new Map<HostId, unknown>();
  const remoteSnapshotsInFlight = new Map<HostId, Promise<void>>();
  let snapshotInFlight: Promise<void> | undefined;
  let cloneReconcileInFlight: Promise<State> | undefined;
  let clonePollInFlight: Promise<void> | undefined;
  let disposed = false;
  let sequence = 0;
  const inFlightTargets = new Set<string>();
  const hotCopyTasks = new Map<Repo["id"], Promise<void>>();
  const queuedHotCopies = new Map<Repo["id"], number>();
  let hotRefreshInFlight: Promise<void> | undefined;
  let backgroundController = new AbortController();
  let scheduleHotCopy: (repo: Repo, count?: number) => Promise<void> = () => Promise.resolve();

  const dispatch = (action: Action): void => {
    if (!disposed) deps.store.dispatch(action);
  };

  const nextId = (prefix: "op" | "toast"): string => {
    sequence += 1;
    return `${prefix}-${deps.clock.now().getTime()}-${sequence}`;
  };

  const toast = (level: Toast["level"], text: string): void => {
    dispatch({
      type: "toast",
      toast: { id: nextId("toast"), level, text },
    });
  };

  const reportError = (error: unknown): SwarmError => {
    const swarmError = asSwarmError(error);
    deps.logger.error(swarmError.message, { code: swarmError.code, cause: swarmError.cause });
    toast("error", swarmError.message);
    return swarmError;
  };

  const replaceStatuses = (
    targets: Worktree[],
    statuses: Map<WorktreeId, WorktreeStatus>,
  ): void => {
    const state = deps.store.getState();
    const targetIds = new Set(targets.map((worktree) => worktree.id));
    const currentIds = new Set(state.worktrees.map((worktree) => worktree.id));
    const retained = Object.fromEntries(
      Object.entries(state.statuses).filter(
        ([worktreeId]) => currentIds.has(worktreeId) && !targetIds.has(worktreeId),
      ),
    ) as Record<WorktreeId, WorktreeStatus>;
    dispatch({ type: "statuses", statuses: { ...retained, ...statusRecord(statuses) } });
  };

  const setRemoteError = (hostId: HostId, error?: SwarmError): void => {
    const previous = deps.store.getState().remoteErrors[hostId];
    const next = error?.message;
    if (previous === next) return;
    dispatch({ type: "remoteError", hostId, error: next });
    if (error) {
      deps.logger.error(error.message, { hostId, code: error.code, cause: error.cause });
    }
  };

  const snapshot = async (worktrees: Worktree[], skipIfBusy: boolean): Promise<void> => {
    if (disposed) return;
    if (snapshotInFlight) {
      if (skipIfBusy) return;
      await snapshotInFlight;
      if (disposed) return;
    }

    const localWorktrees = worktrees.filter((worktree) => worktreeHost(worktree) === "local");
    const task = startup
      .measure("background.statusSnapshot", () => deps.status.snapshot(localWorktrees))
      .then((statuses) => {
        replaceStatuses(localWorktrees, statuses);
      })
      .catch((error: unknown) => {
        if (!disposed) reportError(error);
      });
    snapshotInFlight = task;
    await task;
    if (snapshotInFlight === task) snapshotInFlight = undefined;
  };

  const refreshRemoteStatus = (hostId: HostId, skipIfBusy: boolean): Promise<void> => {
    const existing = remoteSnapshotsInFlight.get(hostId);
    if (existing) return skipIfBusy ? Promise.resolve() : existing;
    const remoteHosts = deps.remoteHosts;
    if (disposed || !remoteHosts) return Promise.resolve();

    const task = startup
      .measure(`background.remoteStatus.${hostId}`, () => remoteHosts.remoteSnapshot(hostId))
      .then((statuses) => {
        const mirrors = deps.store
          .getState()
          .worktrees.filter((worktree) => worktree.host === hostId);
        replaceStatuses(mirrors, statuses);
        setRemoteError(hostId, remoteHosts.lastError(hostId));
      })
      .catch((error: unknown) => {
        setRemoteError(hostId, asSwarmError(error));
      });
    remoteSnapshotsInFlight.set(hostId, task);
    void task.finally(() => {
      if (remoteSnapshotsInFlight.get(hostId) === task) remoteSnapshotsInFlight.delete(hostId);
    });
    return task;
  };

  const applySyncResults = (results: Array<{ hostId: HostId; error?: SwarmError }>): void => {
    for (const result of results) {
      if (result.error) setRemoteError(result.hostId, result.error);
    }
  };

  const syncRemoteHosts = async (): Promise<State> => {
    if (deps.remoteHosts) applySyncResults(await deps.remoteHosts.syncAll());
    return deps.state.load();
  };

  const stopRemoteStatusTimers = (): void => {
    for (const handle of remoteStatusIntervals.values()) deps.clock.clearInterval(handle);
    remoteStatusIntervals.clear();
  };

  const syncRemoteStatusTimers = (): void => {
    stopRemoteStatusTimers();
    if (!deps.remoteHosts) return;
    for (const hostId of Object.keys(currentConfig.hosts)) {
      remoteStatusIntervals.set(
        hostId,
        deps.clock.setInterval(
          () => {
            void refreshRemoteStatus(hostId, true);
          },
          Math.max(minimumRefreshMs, currentConfig.ui.remoteStatusRefreshMs),
        ),
      );
    }
  };

  const hasActiveClone = (): boolean =>
    deps.store.getState().clones.some((clone) => clone.status !== "failed");

  const reconcileCloneState = (): Promise<State> => {
    if (cloneReconcileInFlight) return cloneReconcileInFlight;
    const task = (async () => {
      const knownRepoIds = new Set(deps.store.getState().repos.map((repo) => repo.id));
      await deps.repos.reconcileClones();
      const persisted = await deps.state.load();
      for (const repo of persisted.repos) {
        if (!knownRepoIds.has(repo.id)) void scheduleHotCopy(repo, currentConfig.hotPoolSize);
      }
      return persisted;
    })();
    cloneReconcileInFlight = task;
    void task.then(
      () => {
        if (cloneReconcileInFlight === task) cloneReconcileInFlight = undefined;
      },
      () => {
        if (cloneReconcileInFlight === task) cloneReconcileInFlight = undefined;
      },
    );
    return task;
  };

  const stopClonePolling = (): void => {
    if (cloneInterval === undefined) return;
    deps.clock.clearInterval(cloneInterval);
    cloneInterval = undefined;
  };

  const pollClones = (): Promise<void> => {
    if (clonePollInFlight) return clonePollInFlight;
    if (disposed || !hasActiveClone()) {
      stopClonePolling();
      return Promise.resolve();
    }
    const task = reconcileCloneState()
      .then((persisted) => {
        if (disposed) return;
        dispatch({ type: "hydrate", state: stateFields(persisted) });
        if (!hasActiveClone()) stopClonePolling();
      })
      .catch((error: unknown) => {
        if (!disposed) reportError(error);
      });
    clonePollInFlight = task;
    void task.then(
      () => {
        if (clonePollInFlight === task) clonePollInFlight = undefined;
      },
      () => {
        if (clonePollInFlight === task) clonePollInFlight = undefined;
      },
    );
    return task;
  };

  const syncClonePolling = (): void => {
    if (disposed || !hasActiveClone()) {
      stopClonePolling();
      return;
    }
    if (cloneInterval !== undefined) return;
    cloneInterval = deps.clock.setInterval(() => {
      void pollClones();
    }, cloneRefreshMs);
  };

  const refresh = async (): Promise<void> => {
    if (disposed) return;
    await reconcileCloneState();
    const persisted = await syncRemoteHosts();
    if (disposed) return;
    dispatch({ type: "hydrate", state: stateFields(persisted) });
    syncClonePolling();
    await Promise.all([
      snapshot(persisted.worktrees, false),
      ...Object.keys(currentConfig.hosts).map((hostId) => refreshRemoteStatus(hostId, false)),
    ]);
  };

  const activeContextRepoIds = (): Array<ReturnType<typeof visibleRepos>[number]["id"]> =>
    visibleRepos(deps.store.getState()).map(({ id }) => id);

  const prRepoIds = (): Array<ReturnType<typeof visibleRepos>[number]["id"]> => {
    const state = deps.store.getState();
    const contextRepos = visibleRepos(state);
    if (state.prScope.kind === "repo") {
      const repoId = state.prScope.repoId;
      return contextRepos.some(({ id }) => id === repoId) ? [repoId] : [];
    }
    return contextRepos.map(({ id }) => id);
  };

  const loadPrTabs = async (
    tabs: PrTab[],
    force: boolean,
    repoIds = prRepoIds(),
  ): Promise<void> => {
    await Promise.all(
      tabs.map((tab) =>
        startup.measure(`background.prs.${tab}`, () =>
          deps.prs.load(repoIds, tab, {
            force,
            onSlice(repoId, slice) {
              const previousError = deps.store.getState().prs[tab][repoId]?.error;
              dispatch({ type: "prSlice", tab, repoId, slice });
              if (slice.error && previousError === undefined) {
                deps.logger.error(slice.error, { repoId, tab });
                toast("error", slice.error);
              }
            },
          }),
        ),
      ),
    );
  };

  const runOperation = async (options: {
    label: string;
    targetId?: string;
    success: string;
    refreshAfterSuccess?: boolean;
    showDuplicateToast?: boolean;
    showSuccessToast?: boolean;
    execute: (onEvent: OnEvent) => Promise<unknown>;
    persistError?: boolean;
    clearError?: boolean;
    onPreparedCopyClaimed?: (repoId: Repo["id"]) => void;
  }): Promise<boolean> => {
    if (options.targetId && inFlightTargets.has(options.targetId)) {
      if (options.showDuplicateToast !== false) {
        toast("info", `${options.label} is already in progress`);
      }
      return false;
    }
    if (options.targetId) inFlightTargets.add(options.targetId);
    if (options.clearError) dispatch({ type: "setError", error: undefined });
    const startedAt = deps.clock.now().getTime();
    const id = nextId("op");
    const operation: Operation = {
      id,
      label: options.label,
      step: "Starting",
      log: [],
      targetId: options.targetId,
      startedAt,
    };
    dispatch({ type: "opStart", op: operation });

    let step = operation.step;
    let eventError: SwarmError | undefined;
    let pendingLogs: Array<{ step: string; line: string }> = [];
    let logTimer: ReturnType<typeof setTimeout> | undefined;
    const flushLog = (): void => {
      if (logTimer !== undefined) clearTimeout(logTimer);
      logTimer = undefined;
      const logs = pendingLogs;
      pendingLogs = [];
      for (const pending of logs) {
        dispatch({ type: "opStep", id, step: pending.step, line: pending.line });
      }
    };
    const onEvent: OnEvent = (event) => {
      if (disposed) return;
      if (event.type === "step") {
        step = event.label;
        dispatch({ type: "opStep", id, step });
      } else if (event.type === "log") {
        pendingLogs.push({ step, line: event.line });
        if (logTimer === undefined) {
          logTimer = setTimeout(flushLog, 16);
          logTimer.unref();
        }
      } else if (event.type === "error") {
        eventError = event.error;
      } else if (event.type === "prepared-copy-claimed") {
        options.onPreparedCopyClaimed?.(event.repoId);
      }
    };

    let succeeded = false;
    try {
      await options.execute(onEvent);
      if (eventError !== undefined) throw eventError;
      succeeded = true;
    } catch (error) {
      const reported = reportError(error);
      if (options.persistError) dispatch({ type: "setError", error: reported.message });
    } finally {
      flushLog();
      dispatch({ type: "opEnd", id });
      if (options.targetId) inFlightTargets.delete(options.targetId);
    }

    if (!succeeded || disposed) return false;
    if (options.refreshAfterSuccess === false) {
      if (options.showSuccessToast !== false) toast("success", options.success);
      return true;
    }
    try {
      await refresh();
      if (options.showSuccessToast !== false) toast("success", options.success);
      return true;
    } catch (error) {
      reportError(error);
      return false;
    }
  };

  scheduleHotCopy = (repo, count = 1): Promise<void> => {
    if (disposed || count <= 0) return Promise.resolve();
    queuedHotCopies.set(repo.id, (queuedHotCopies.get(repo.id) ?? 0) + count);
    const current = hotCopyTasks.get(repo.id);
    if (current) return current;
    const task = (async () => {
      while (!disposed && (queuedHotCopies.get(repo.id) ?? 0) > 0) {
        queuedHotCopies.set(repo.id, (queuedHotCopies.get(repo.id) ?? 1) - 1);
        await runOperation({
          label: `Preparing next worktree copy for ${repo.id}`,
          targetId: `hot-copy:${repo.id}`,
          success: `Prepared next worktree copy for ${repo.id}`,
          refreshAfterSuccess: false,
          showDuplicateToast: false,
          showSuccessToast: false,
          execute: (onEvent) =>
            deps.worktrees.prepareHotCopy(repo.id, onEvent, {
              signal: backgroundController.signal,
            }),
        });
      }
    })();
    hotCopyTasks.set(repo.id, task);
    void task.finally(() => {
      if (hotCopyTasks.get(repo.id) === task) hotCopyTasks.delete(repo.id);
      const remaining = queuedHotCopies.get(repo.id) ?? 0;
      queuedHotCopies.delete(repo.id);
      if (!disposed && remaining > 0) void scheduleHotCopy(repo, remaining);
    });
    return task;
  };

  const prepareReposWithLimit = async (repos: Repo[], concurrency: number): Promise<void> => {
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (!disposed) {
        const repo = repos[cursor];
        cursor += 1;
        if (!repo) return;
        await scheduleHotCopy(repo, Math.max(1, currentConfig.hotPoolSize));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, repos.length) }, () => worker()));
  };

  const refreshPreparedCopies = (): Promise<void> => {
    if (hotRefreshInFlight) return hotRefreshInFlight;
    const task = (async () => {
      if (disposed || currentConfig.hotPoolSize === 0) return;
      for (const repo of deps.store.getState().repos) {
        if (disposed) return;
        try {
          await deps.worktrees.refreshPreparedCopy(repo.id, {
            skipIfFresh: true,
            signal: backgroundController.signal,
          });
        } catch (error) {
          deps.logger.warn(`Periodic prepared-copy refresh failed: ${repo.id}`, error);
        }
      }
    })();
    hotRefreshInFlight = task;
    void task.finally(() => {
      if (hotRefreshInFlight === task) hotRefreshInFlight = undefined;
    });
    return task;
  };

  const stopHotRefreshTimer = (): void => {
    if (hotRefreshInterval === undefined) return;
    deps.clock.clearInterval(hotRefreshInterval);
    hotRefreshInterval = undefined;
  };

  const syncHotRefreshTimer = (): void => {
    stopHotRefreshTimer();
    if (
      !deps.enableHotRefreshTimer ||
      currentConfig.hotPoolSize === 0 ||
      currentConfig.hotRefreshIntervalMs === 0
    ) {
      return;
    }
    hotRefreshInterval = deps.clock.setInterval(() => {
      void refreshPreparedCopies();
    }, currentConfig.hotRefreshIntervalMs);
  };

  const schedulePostCreateHooks = (worktree: Worktree): void => {
    const repo = deps.store.getState().repos.find((candidate) => candidate.id === worktree.repoId);
    if (!repo || repo.hooks.postCreate.length === 0 || disposed) return;
    void runOperation({
      label: `Post-create hooks · ${worktree.slug}`,
      targetId: `post-create:${worktree.id}`,
      success: `Post-create hooks finished · ${worktree.slug}`,
      refreshAfterSuccess: false,
      showDuplicateToast: false,
      showSuccessToast: false,
      execute: (onEvent) => deps.worktrees.runPostCreateHooks(worktree.id, onEvent),
    });
  };

  const requireWorktree = (): Worktree | undefined => {
    const worktree = selectedWorktree(deps.store.getState());
    if (!worktree) reportError(new SwarmError("not-found", "No worktree is selected"));
    return worktree;
  };

  const closeAndRun = (operation: () => Promise<unknown>): void => {
    dispatch({ type: "closeDialog" });
    void operation();
  };

  const controller: Controller = {
    async init() {
      backgroundController.abort();
      backgroundController = new AbortController();
      disposed = false;
      if (statusInterval !== undefined) {
        deps.clock.clearInterval(statusInterval);
        statusInterval = undefined;
      }
      stopClonePolling();
      stopHotRefreshTimer();
      stopRemoteStatusTimers();

      try {
        const currentSession = startup
          .measure("controller.tmuxCurrentSession", () => deps.tmux.currentSession())
          .then((session) => {
            dispatch({ type: "setCurrentSession", session: session ?? undefined });
          })
          .catch((error: unknown) => {
            if (!disposed) reportError(error);
          });
        void currentSession;

        await startup.measure("controller.worktreeReconcile", () =>
          deps.worktrees.reconcileCreating(),
        );
        const persisted = await startup.measure("controller.stateLoad", () => deps.state.load());
        dispatch({
          type: "hydrate",
          state: {
            ...stateFields(persisted),
            loading: false,
            error: undefined,
          },
        });

        void prepareReposWithLimit(persisted.repos, 2);

        syncClonePolling();
        void startup
          .measure("controller.cloneReconcile", reconcileCloneState)
          .then((reconciled) => {
            dispatch({ type: "hydrate", state: stateFields(reconciled) });
            syncClonePolling();
          })
          .catch((error: unknown) => {
            if (!disposed) reportError(error);
          });
        void snapshot(persisted.worktrees, true);
        void startup
          .measure("controller.remoteSync", syncRemoteHosts)
          .then(async (synced) => {
            if (disposed) return;
            dispatch({ type: "hydrate", state: stateFields(synced) });
            await Promise.all(
              Object.keys(currentConfig.hosts).map((hostId) => refreshRemoteStatus(hostId, false)),
            );
          })
          .catch((error: unknown) => {
            if (!disposed) reportError(error);
          });
        statusInterval = deps.clock.setInterval(
          () => {
            if (deps.store.getState().operations.length > 0) return;
            void snapshot(deps.store.getState().worktrees, true);
          },
          Math.max(minimumRefreshMs, currentConfig.ui.statusRefreshMs),
        );
        syncRemoteStatusTimers();
        syncHotRefreshTimer();
        void loadPrTabs(["mine", "review"], false, activeContextRepoIds());
      } catch (error) {
        const swarmError = reportError(error);
        dispatch({
          type: "hydrate",
          state: { loading: false, error: swarmError.message },
        });
        throw swarmError;
      }
    },

    refresh,

    async setContext(id) {
      try {
        await deps.contexts.setActive(id);
        dispatch({ type: "setContext", contextId: id });
        void loadPrTabs(["mine", "review"], false, activeContextRepoIds());
      } catch (error) {
        throw reportError(error);
      }
    },

    async openSelected(options) {
      const worktree = selectedWorktree(deps.store.getState());
      if (!worktree) {
        throw reportError(new SwarmError("not-found", "No worktree is selected"));
      }
      try {
        await deps.sessions.open(worktree, options);
      } catch (error) {
        throw reportError(error);
      }
    },

    async sleepSelected() {
      const worktree = requireWorktree();
      if (!worktree) return;
      try {
        const hostId = worktreeHost(worktree);
        if (hostId === "local" && !(await deps.tmux.hasSession(worktree.session))) {
          toast("info", `${worktree.branch} is already asleep`);
          return;
        }
        const report = await deps.sessions.unmount(worktree);
        const sessionSummary = report.sessionKilled ? "; session closed" : "";
        toast(
          "success",
          `Slept ${worktree.branch}: kept ${report.kept.length}, closed ${report.closed.length}${sessionSummary}`,
        );
        if (hostId === "local") await snapshot(deps.store.getState().worktrees, false);
        else await refreshRemoteStatus(hostId, false);
      } catch (error) {
        reportError(error);
      }
    },

    async killSelected() {
      const worktree = requireWorktree();
      if (!worktree) return;
      dispatch({
        type: "openDialog",
        dialog: {
          kind: "confirm",
          title: "Kill session?",
          body: [worktree.session, "All processes in this session will be stopped."],
          danger: true,
          confirmLabel: "Kill",
          onConfirm: () => {
            closeAndRun(async () => {
              try {
                await deps.sessions.kill(worktree);
                toast("success", `Killed ${worktree.session}`);
                const hostId = worktreeHost(worktree);
                if (hostId === "local") await snapshot(deps.store.getState().worktrees, false);
                else await refreshRemoteStatus(hostId, false);
              } catch (error) {
                reportError(error);
              }
            });
          },
        },
      });
    },

    async createWorktree(input) {
      const targetId = worktreeId(input.repoId, slugify(input.branch));
      const hostId = input.host ?? currentConfig.defaultHost;
      if (hostId !== "local") {
        const remoteHosts = deps.remoteHosts;
        const repo = deps.store.getState().repos.find((candidate) => candidate.id === input.repoId);
        if (!remoteHosts || !repo) {
          reportError(
            new SwarmError(
              "not-found",
              !repo
                ? `Repository not found: ${input.repoId}`
                : `Remote host service is unavailable`,
            ),
          );
          return;
        }
        await runOperation({
          label: "Creating worktree",
          targetId,
          success: `Worktree ${input.branch} ready on ${hostId}`,
          refreshAfterSuccess: false,
          execute: async (onEvent) => {
            onEvent({ type: "step", label: `creating on ${hostId}…` });
            await remoteHosts.create(hostId, {
              repo,
              slug: slugify(input.branch),
              branch: input.branch,
              baseRef: input.baseRef ?? `origin/${repo.defaultBranch}`,
            });
            await remoteHosts.sync(hostId);
            applySyncResults(await remoteHosts.syncAll());
            const persisted = await deps.state.load();
            dispatch({ type: "hydrate", state: stateFields(persisted) });
            await refreshRemoteStatus(hostId, false);
          },
        });
        return;
      }

      let created: Worktree | undefined;
      let replenishing = false;
      const succeeded = await runOperation({
        label: "Creating worktree",
        targetId,
        success: `Worktree ${input.branch} ready`,
        execute: async (onEvent) => {
          created = await deps.worktrees.create(input, onEvent);
          schedulePostCreateHooks(created);
        },
        onPreparedCopyClaimed: (repoId) => {
          replenishing = true;
          const repo = deps.store.getState().repos.find((candidate) => candidate.id === repoId);
          if (repo) void scheduleHotCopy(repo);
        },
      });
      if (!replenishing) {
        const repo = deps.store.getState().repos.find((candidate) => candidate.id === input.repoId);
        if (repo) void scheduleHotCopy(repo, currentConfig.hotPoolSize);
      }
      if (!succeeded || !created) return;
    },

    async remoteBranches(repoId) {
      try {
        return await deps.worktrees.remoteBranches(repoId);
      } catch (error) {
        throw reportError(error);
      }
    },

    refreshPreparedCopy(repoId) {
      const dialog = deps.store.getState().dialog;
      if (dialog?.kind !== "create-worktree" || dialog.repoId !== repoId) return;
      const { generation } = dialog;
      dispatch({ type: "updateCreateWorktreeBranches", repoId, generation, fetching: true });
      void (async () => {
        try {
          await deps.worktrees.refreshPreparedCopy(repoId, {
            signal: backgroundController.signal,
          });
          const branches = await deps.worktrees.remoteBranches(repoId);
          dispatch({
            type: "updateCreateWorktreeBranches",
            repoId,
            generation,
            branches,
            fetching: false,
          });
        } catch (error) {
          deps.logger.warn(`Prepared-copy pre-fetch failed: ${repoId}`, error);
          dispatch({
            type: "updateCreateWorktreeBranches",
            repoId,
            generation,
            fetching: false,
          });
        }
      })();
    },

    async deleteSelected() {
      const state = deps.store.getState();
      if (state.pane === "worktrees") {
        const worktree = selectedWorktree(state);
        if (!worktree) {
          reportError(new SwarmError("not-found", "No worktree is selected"));
          return;
        }
        const status = state.statuses[worktree.id];
        dispatch({
          type: "openDialog",
          dialog: {
            kind: "confirm",
            title: "Delete worktree?",
            body: [
              `Path: ${worktree.path}`,
              `Session: ${status?.session === "unknown" ? "offline" : (status?.session ?? "none")}`,
              `Running agents: ${status?.running.join(", ") || "none"}`,
            ],
            danger: true,
            confirmLabel: "Delete",
            onConfirm: () => {
              closeAndRun(() =>
                runOperation({
                  label: "Deleting worktree",
                  targetId: worktree.id,
                  success: `Deleted worktree ${worktree.branch}`,
                  execute: (onEvent) => deps.worktrees.delete(worktree.id, onEvent),
                }),
              );
            },
          },
        });
        return;
      }

      const repo = selectedRepo(state);
      if (!repo) {
        reportError(new SwarmError("not-found", "No repo is selected"));
        return;
      }
      const repoWorktrees = state.worktrees.filter((worktree) => worktree.repoId === repo.id);
      const sessions = repoWorktrees
        .filter((worktree) => {
          const session = state.statuses[worktree.id]?.session;
          return session === "attached" || session === "detached";
        })
        .map((worktree) => worktree.session);
      dispatch({
        type: "openDialog",
        dialog: {
          kind: "confirm",
          title: "Delete repo?",
          body: [
            `Path: ${repo.path}`,
            `Worktrees: ${repoWorktrees.length}`,
            `Sessions to kill: ${sessions.join(", ") || "none"}`,
          ],
          danger: true,
          confirmLabel: "Delete",
          onConfirm: () => {
            closeAndRun(() =>
              runOperation({
                label: "Deleting repo",
                targetId: repo.id,
                success: `Deleted repo ${repo.id}`,
                execute: (onEvent) => deps.repos.delete(repo.id, onEvent),
              }),
            );
          },
        },
      });
    },

    async cloneRepo(remote) {
      const contextId = deps.store.getState().activeContextId;
      if (!contextId) {
        reportError(new SwarmError("not-found", "No context is active"));
        return;
      }
      await runOperation({
        label: "Cloning repo",
        targetId: remote.fullName,
        success: `Cloning ${remote.fullName} in background`,
        execute: (onEvent) => deps.repos.clone(remote, contextId, onEvent),
      });
    },

    async searchRemote(query, signal) {
      const contextId = deps.store.getState().activeContextId;
      if (!contextId) throw new SwarmError("not-found", "No context is active");
      return deps.repos.searchRemote(contextId, query, { signal });
    },

    async assignRepo(repoId, contextId) {
      try {
        await deps.repos.assign(repoId, contextId);
        await refresh();
        toast("success", `Moved ${repoId}`);
      } catch (error) {
        reportError(error);
      }
    },

    async saveContext(input) {
      try {
        if (input.id) {
          await deps.contexts.update(input.id, { name: input.name, owners: input.owners });
          dispatch({ type: "closeDialog" });
          await refresh();
          toast("success", `Updated context ${input.name}`);
          return;
        }

        const context = await deps.contexts.create({ name: input.name, owners: input.owners });
        await deps.contexts.setActive(context.id);
        dispatch({ type: "closeDialog" });
        await refresh();
        dispatch({ type: "setContext", contextId: context.id });
        toast("success", `Created context ${context.name}`);
      } catch (error) {
        reportError(error);
      }
    },

    async deleteContext(id) {
      const state = deps.store.getState();
      const context = state.contexts.find((candidate) => candidate.id === id);
      if (!context) {
        reportError(new SwarmError("not-found", `Context not found: ${id}`));
        return;
      }
      const repoIds = new Set(
        state.repos.filter((repo) => repo.contextId === id).map((repo) => repo.id),
      );
      const contextWorktrees = state.worktrees.filter((worktree) => repoIds.has(worktree.repoId));
      const sessionCount = contextWorktrees.filter((worktree) => {
        const session = state.statuses[worktree.id]?.session;
        return session === "attached" || session === "detached";
      }).length;
      dispatch({
        type: "openDialog",
        dialog: {
          kind: "confirm",
          title: "Delete context?",
          body: [
            context.name,
            `Repos: ${repoIds.size}`,
            `Worktrees: ${contextWorktrees.length}`,
            `Sessions to kill: ${sessionCount}`,
          ],
          danger: true,
          confirmLabel: "Delete",
          onConfirm: () => {
            closeAndRun(() =>
              runOperation({
                label: "Deleting context",
                targetId: id,
                success: `Deleted context ${context.name}`,
                execute: (onEvent) => deps.contexts.delete(id, onEvent),
              }),
            );
          },
        },
      });
    },

    async saveConfig(patch) {
      const next = { ...currentConfig, ...patch };
      try {
        await deps.config.save(next);
        currentConfig = next;
        syncHotRefreshTimer();
        syncRemoteStatusTimers();
        dispatch({ type: "setConfig", config: next });
        dispatch({ type: "closeDialog" });
        toast("success", "Settings saved");
      } catch (error) {
        reportError(error);
      }
    },

    getConfig() {
      return currentConfig;
    },

    async yankPath() {
      const worktree = requireWorktree();
      if (!worktree) return;
      try {
        const hostId = worktreeHost(worktree);
        const path = hostId === "local" ? worktree.path : `${hostId}:${worktree.path}`;
        await deps.clipboard.copy(path);
        toast("success", `Copied ${path}`);
      } catch (error) {
        reportError(error);
      }
    },

    async openPrs() {
      const state = deps.store.getState();
      const repo = selectedRepo(state);
      const scope = repo ? { kind: "repo" as const, repoId: repo.id } : { kind: "all" as const };
      const worktree = state.pane === "worktrees" ? selectedWorktree(state) : undefined;
      const linked = worktree ? worktreePr(state, worktree) : undefined;
      const scopedState = { ...state, prTab: "mine" as const, prScope: scope };
      const cursor = linked
        ? Math.max(
            0,
            prsInScope(scopedState, "mine").findIndex(
              (pr) => pr.repoId === linked.repoId && pr.number === linked.number,
            ),
          )
        : 0;
      dispatch({ type: "setPrTab", tab: "mine" });
      dispatch({ type: "setScreen", screen: "prs", scope, cursor });
      void loadPrTabs(["mine", "review"], false);
    },

    async refreshPrs({ force }) {
      await loadPrTabs(["mine", "review"], force);
    },

    async update() {
      const succeeded = await runOperation({
        label: "Updating swarm",
        targetId: "swarm:update",
        success: "Swarm updated; restarting…",
        refreshAfterSuccess: false,
        showDuplicateToast: false,
        persistError: true,
        clearError: true,
        execute: (onEvent) => deps.updater.update(deps.installRoot, onEvent),
      });
      if (succeeded) deps.lifecycle.requestExit(75);
    },

    async openSelectedPr({ keepPrevious }) {
      const state = deps.store.getState();
      const pr = selectedPr(state);
      if (!pr) {
        throw reportError(new SwarmError("not-found", "No pull request is selected"));
      }
      const linked = prWorktree(state, pr);
      if (linked) {
        try {
          await deps.sessions.open(linked, { sleepPrevious: !keepPrevious });
          return;
        } catch (error) {
          throw reportError(error);
        }
      }

      const branch = prLocalBranch(pr);
      try {
        validateBranch(branch);
      } catch (error) {
        throw reportError(error);
      }
      let created: Worktree | undefined;
      let failure: unknown;
      let replenishing = false;
      await runOperation({
        label: "Creating worktree",
        targetId: worktreeId(pr.repoId, slugify(branch)),
        success: `Worktree ${branch} ready`,
        execute: async (onEvent) => {
          try {
            created = await deps.worktrees.create(
              {
                repoId: pr.repoId,
                branch,
                source: { kind: "pull" as const, number: pr.number },
              },
              onEvent,
            );
            schedulePostCreateHooks(created);
            return created;
          } catch (error) {
            failure = error;
            throw error;
          }
        },
        onPreparedCopyClaimed: (repoId) => {
          replenishing = true;
          const repo = deps.store.getState().repos.find((candidate) => candidate.id === repoId);
          if (repo) void scheduleHotCopy(repo);
        },
      });
      if (!replenishing) {
        const repo = deps.store.getState().repos.find((candidate) => candidate.id === pr.repoId);
        if (repo) void scheduleHotCopy(repo, currentConfig.hotPoolSize);
      }
      if (failure !== undefined) throw failure;
      if (!created) throw new SwarmError("conflict", `Worktree creation already in progress`);
      try {
        await deps.sessions.open(created, { sleepPrevious: !keepPrevious });
      } catch (error) {
        throw reportError(error);
      }
    },

    async browseSelectedPr() {
      const pr = selectedPr(deps.store.getState());
      if (!pr) {
        reportError(new SwarmError("not-found", "No pull request is selected"));
        return;
      }
      try {
        await deps.process.openUrl(pr.url);
      } catch (error) {
        reportError(error);
      }
    },

    async browseSelectedWorktreePr() {
      const state = deps.store.getState();
      if (state.pane !== "worktrees") return;
      const worktree = selectedWorktree(state);
      if (!worktree) return;
      try {
        const pr =
          worktreePr(state, worktree) ??
          (await deps.prs.findByBranch(worktree.repoId, worktree.branch));
        if (!pr) return;
        await deps.process.openUrl(pr.url);
      } catch (error) {
        reportError(error);
      }
    },

    async yankSelectedPr() {
      const pr = selectedPr(deps.store.getState());
      if (!pr) {
        reportError(new SwarmError("not-found", "No pull request is selected"));
        return;
      }
      try {
        await deps.clipboard.copy(pr.url);
        toast("success", "Copied PR URL");
      } catch (error) {
        reportError(error);
      }
    },

    backToMain() {
      dispatch({ type: "setScreen", screen: "main" });
    },

    setPrTab(tab) {
      dispatch({ type: "setPrTab", tab });
    },

    dispose() {
      disposed = true;
      backgroundController.abort();
      deps.worktrees.dispose?.();
      if (statusInterval !== undefined) {
        deps.clock.clearInterval(statusInterval);
        statusInterval = undefined;
      }
      stopClonePolling();
      stopHotRefreshTimer();
      stopRemoteStatusTimers();
    },
  };

  return controller;
}
