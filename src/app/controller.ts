import type { Action, Controller, Operation, Store, Toast } from "../core/app.ts";
import { SwarmError } from "../core/errors.ts";
import { slugify, worktreeId } from "../core/paths.ts";
import type {
  Clipboard,
  Clock,
  ConfigPort,
  Logger,
  ProcessPort,
  StatePort,
  TmuxPort,
} from "../core/ports.ts";
import { prLocalBranch, validateBranch } from "../core/prs.ts";
import type {
  ContextService,
  OnEvent,
  PrService,
  RepoService,
  SessionService,
  StatusService,
  WorktreeService,
} from "../core/services.ts";
import { noStartupTiming, type StartupTiming } from "../core/startup.ts";
import type { PrTab, State, Worktree, WorktreeId, WorktreeStatus } from "../core/types.ts";
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
  config: ConfigPort;
  state: StatePort;
  tmux: TmuxPort;
  clipboard: Clipboard;
  process: ProcessPort;
  clock: Clock;
  logger: Logger;
  startup?: StartupTiming;
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
  let snapshotInFlight: Promise<void> | undefined;
  let cloneReconcileInFlight: Promise<State> | undefined;
  let clonePollInFlight: Promise<void> | undefined;
  let disposed = false;
  let sequence = 0;
  const inFlightTargets = new Set<string>();

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

  const snapshot = async (worktrees: Worktree[], skipIfBusy: boolean): Promise<void> => {
    if (disposed) return;
    if (snapshotInFlight) {
      if (skipIfBusy) return;
      await snapshotInFlight;
      if (disposed) return;
    }

    const task = startup
      .measure("background.statusSnapshot", () => deps.status.snapshot(worktrees))
      .then((statuses) => {
        dispatch({ type: "statuses", statuses: statusRecord(statuses) });
      })
      .catch((error: unknown) => {
        if (!disposed) reportError(error);
      });
    snapshotInFlight = task;
    await task;
    if (snapshotInFlight === task) snapshotInFlight = undefined;
  };

  const hasActiveClone = (): boolean =>
    deps.store.getState().clones.some((clone) => clone.status !== "failed");

  const reconcileCloneState = (): Promise<State> => {
    if (cloneReconcileInFlight) return cloneReconcileInFlight;
    const task = (async () => {
      await deps.repos.reconcileClones();
      return deps.state.load();
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
    const persisted = await reconcileCloneState();
    if (disposed) return;
    dispatch({ type: "hydrate", state: stateFields(persisted) });
    syncClonePolling();
    await snapshot(persisted.worktrees, false);
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
    execute: (onEvent: OnEvent) => Promise<unknown>;
  }): Promise<void> => {
    if (options.targetId && inFlightTargets.has(options.targetId)) {
      toast("info", `${options.label} is already in progress`);
      return;
    }
    if (options.targetId) inFlightTargets.add(options.targetId);
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
    let pendingLog: string | undefined;
    let logTimer: ReturnType<typeof setTimeout> | undefined;
    const flushLog = (): void => {
      if (logTimer !== undefined) clearTimeout(logTimer);
      logTimer = undefined;
      if (pendingLog === undefined) return;
      dispatch({ type: "opStep", id, step, line: pendingLog });
      pendingLog = undefined;
    };
    const onEvent: OnEvent = (event) => {
      if (disposed) return;
      if (event.type === "step") {
        step = event.label;
        dispatch({ type: "opStep", id, step });
      } else if (event.type === "log") {
        pendingLog = event.line;
        logTimer ??= setTimeout(flushLog, 16);
      } else if (event.type === "error") {
        eventError = event.error;
      }
    };

    let succeeded = false;
    try {
      await options.execute(onEvent);
      if (eventError !== undefined) throw eventError;
      succeeded = true;
    } catch (error) {
      reportError(error);
    } finally {
      flushLog();
      dispatch({ type: "opEnd", id });
      if (options.targetId) inFlightTargets.delete(options.targetId);
    }

    if (!succeeded || disposed) return;
    try {
      await refresh();
      toast("success", options.success);
    } catch (error) {
      reportError(error);
    }
  };

  const requireWorktree = (): Worktree | undefined => {
    const worktree = selectedWorktree(deps.store.getState());
    if (!worktree) reportError(new SwarmError("not-found", "No worktree is selected"));
    return worktree;
  };

  const closeAndRun = (operation: () => Promise<void>): void => {
    dispatch({ type: "closeDialog" });
    void operation();
  };

  const controller: Controller = {
    async init() {
      disposed = false;
      if (statusInterval !== undefined) {
        deps.clock.clearInterval(statusInterval);
        statusInterval = undefined;
      }
      stopClonePolling();

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

        const persisted = await startup.measure("controller.stateLoad", () => deps.state.load());
        dispatch({
          type: "hydrate",
          state: {
            ...stateFields(persisted),
            loading: false,
            error: undefined,
          },
        });

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
        statusInterval = deps.clock.setInterval(
          () => {
            if (deps.store.getState().operations.length > 0) return;
            void snapshot(deps.store.getState().worktrees, true);
          },
          Math.max(minimumRefreshMs, currentConfig.ui.statusRefreshMs),
        );
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
        if (!(await deps.tmux.hasSession(worktree.session))) {
          toast("info", `${worktree.branch} is already asleep`);
          return;
        }
        const report = await deps.sessions.unmount(worktree);
        const sessionSummary = report.sessionKilled ? "; session closed" : "";
        toast(
          "success",
          `Slept ${worktree.branch}: kept ${report.kept.length}, closed ${report.closed.length}${sessionSummary}`,
        );
        await snapshot(deps.store.getState().worktrees, false);
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
                await snapshot(deps.store.getState().worktrees, false);
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
      await runOperation({
        label: "Creating worktree",
        targetId,
        success: `Worktree ${input.branch} ready`,
        execute: (onEvent) => deps.worktrees.create(input, onEvent),
      });
    },

    async remoteBranches(repoId) {
      try {
        return await deps.worktrees.remoteBranches(repoId);
      } catch (error) {
        throw reportError(error);
      }
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
              `Session: ${status?.session ?? "none"}`,
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
        .filter((worktree) => state.statuses[worktree.id]?.session !== "none")
        .filter((worktree) => state.statuses[worktree.id] !== undefined)
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
      const sessionCount = contextWorktrees.filter(
        (worktree) =>
          state.statuses[worktree.id]?.session !== undefined &&
          state.statuses[worktree.id]?.session !== "none",
      ).length;
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
        await deps.clipboard.copy(worktree.path);
        toast("success", `Copied ${worktree.path}`);
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
                ...(pr.isCrossRepository
                  ? { source: { kind: "pull" as const, number: pr.number } }
                  : {}),
              },
              onEvent,
            );
            return created;
          } catch (error) {
            failure = error;
            throw error;
          }
        },
      });
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
      if (statusInterval !== undefined) {
        deps.clock.clearInterval(statusInterval);
        statusInterval = undefined;
      }
      stopClonePolling();
    },
  };

  return controller;
}
