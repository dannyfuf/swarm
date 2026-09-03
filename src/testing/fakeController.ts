import { selectedPr, selectedRepo, selectedWorktree, worktreePr } from "../app/selectors.ts";
import type { AppState, Controller, Operation, Store } from "../core/app.ts";
import { SwarmError } from "../core/errors.ts";
import { slugify, worktreeId } from "../core/paths.ts";
import type { Config, ContextId, RemoteRepo, State, WorktreeId } from "../core/types.ts";
import {
  config as defaultFixtureConfig,
  remoteRepos as defaultRemoteRepos,
  makeState,
} from "./fixtures.ts";

export interface FakeControllerFixtures {
  state?: State;
  config?: Config;
  remoteRepos?: RemoteRepo[];
  operationDelayMs?: number;
}

export type FakeController = Controller & {
  readonly remoteRepos: RemoteRepo[];
  readonly yankedPaths: string[];
  readonly disposed: boolean;
  readonly yankedPrUrls: string[];
  readonly browsedPrUrls: string[];
};

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createFakeController(
  store: Store,
  fixtures: FakeControllerFixtures = {},
): FakeController {
  const fixtureState = structuredClone(fixtures.state ?? makeState());
  let config = structuredClone(fixtures.config ?? defaultFixtureConfig);
  const remotes = structuredClone(fixtures.remoteRepos ?? defaultRemoteRepos);
  const delayMs = fixtures.operationDelayMs ?? 300;
  const yankedPaths: string[] = [];
  const yankedPrUrls: string[] = [];
  const browsedPrUrls: string[] = [];
  let disposed = false;
  let operationSequence = 0;

  const patchState = (patch: Partial<AppState>): void => {
    store.dispatch({ type: "hydrate", state: patch });
  };

  const runOperation = async (label: string, targetId?: string): Promise<void> => {
    operationSequence += 1;
    const id = `fake-op-${operationSequence}`;
    const op: Operation = {
      id,
      label,
      step: "Starting",
      log: [],
      targetId,
      startedAt: Date.now(),
    };
    store.dispatch({ type: "opStart", op });
    await wait(Math.floor(delayMs / 2));
    store.dispatch({ type: "opStep", id, step: "Working", line: `${label} in progress` });
    await wait(Math.ceil(delayMs / 2));
    store.dispatch({ type: "opEnd", id });
  };

  const requireWorktree = () => {
    const worktree = selectedWorktree(store.getState());
    if (!worktree) throw new SwarmError("not-found", "No worktree is selected");
    return worktree;
  };

  const removeWorktree = async (id: WorktreeId): Promise<void> => {
    await runOperation("Deleting worktree", id);
    patchState({ worktrees: store.getState().worktrees.filter((worktree) => worktree.id !== id) });
    store.dispatch({
      type: "toast",
      toast: { id: `deleted-${id}`, level: "success", text: "Worktree deleted" },
    });
    store.dispatch({ type: "closeDialog" });
  };

  const controller: FakeController = {
    get remoteRepos() {
      return remotes;
    },
    yankedPaths,
    yankedPrUrls,
    browsedPrUrls,
    get disposed() {
      return disposed;
    },
    async init() {
      patchState({
        contexts: fixtureState.contexts,
        repos: fixtureState.repos,
        clones: fixtureState.clones,
        worktrees: fixtureState.worktrees,
        activeContextId: fixtureState.activeContextId,
        config,
        loading: false,
      });
    },
    async refresh() {
      await runOperation("Refreshing");
      store.dispatch({
        type: "toast",
        toast: { id: `refresh-${operationSequence}`, level: "success", text: "Refreshed" },
      });
    },
    async setContext(id) {
      if (!store.getState().contexts.some((context) => context.id === id)) {
        throw new SwarmError("not-found", `Context not found: ${id}`);
      }
      store.dispatch({ type: "setContext", contextId: id });
    },
    async openSelected() {
      const worktree = requireWorktree();
      await runOperation("Opening worktree", worktree.id);
      const now = new Date().toISOString();
      patchState({
        worktrees: store
          .getState()
          .worktrees.map((item) =>
            item.id === worktree.id ? { ...item, lastOpenedAt: now } : item,
          ),
      });
      store.dispatch({ type: "setCurrentSession", session: worktree.session });
    },
    async sleepSelected() {
      const worktree = requireWorktree();
      await runOperation("Sleeping worktree", worktree.id);
      const statuses = { ...store.getState().statuses };
      statuses[worktree.id] = {
        worktreeId: worktree.id,
        session: "none",
        windows: [],
        running: [],
      };
      store.dispatch({ type: "statuses", statuses });
    },
    async killSelected() {
      const worktree = requireWorktree();
      await runOperation("Killing session", worktree.id);
      const statuses = { ...store.getState().statuses };
      statuses[worktree.id] = {
        worktreeId: worktree.id,
        session: "none",
        windows: [],
        running: [],
      };
      store.dispatch({ type: "statuses", statuses });
    },
    async createWorktree(input) {
      const repo = store.getState().repos.find((item) => item.id === input.repoId);
      if (!repo) throw new SwarmError("not-found", `Repo not found: ${input.repoId}`);
      const slug = slugify(input.branch);
      const id = worktreeId(repo.id, slug);
      if (store.getState().worktrees.some((worktree) => worktree.id === id)) {
        throw new SwarmError("conflict", `Worktree already exists: ${id}`);
      }
      await runOperation("Creating worktree", id);
      const createdAt = new Date().toISOString();
      patchState({
        worktrees: [
          ...store.getState().worktrees,
          {
            id,
            repoId: repo.id,
            slug,
            branch: input.branch,
            baseRef: input.baseRef ?? `origin/${repo.defaultBranch}`,
            path: `${config.worktreesDir}/${repo.owner}/${repo.name}/${slug}`,
            session: `${repo.name.replace(/[.:]/g, "-")}/${slug.replace(/[.:]/g, "-")}`,
            createdAt,
          },
        ],
      });
      store.dispatch({ type: "closeDialog" });
    },
    async remoteBranches(repoId) {
      const repo = store.getState().repos.find((candidate) => candidate.id === repoId);
      if (!repo) throw new SwarmError("not-found", `Repo not found: ${repoId}`);
      return [
        `origin/${repo.defaultBranch}`,
        ...store
          .getState()
          .worktrees.filter((worktree) => worktree.repoId === repoId)
          .map((worktree) => `origin/${worktree.branch}`),
      ];
    },
    async deleteSelected() {
      const state = store.getState();
      const worktree = selectedWorktree(state);
      const repo = selectedRepo(state);
      if (state.pane === "worktrees" && worktree) {
        store.dispatch({
          type: "openDialog",
          dialog: {
            kind: "confirm",
            title: "Delete worktree?",
            body: [worktree.branch, worktree.path],
            danger: true,
            confirmLabel: "Delete",
            onConfirm: () => void removeWorktree(worktree.id),
          },
        });
        return;
      }
      if (!repo) throw new SwarmError("not-found", "No repo is selected");
      const repoWorktrees = state.worktrees.filter((item) => item.repoId === repo.id);
      store.dispatch({
        type: "openDialog",
        dialog: {
          kind: "confirm",
          title: "Delete repo?",
          body: [repo.id, `${repoWorktrees.length} worktrees will also be deleted`],
          danger: true,
          confirmLabel: "Delete",
          onConfirm: () => {
            void (async () => {
              await runOperation("Deleting repo", repo.id);
              patchState({
                repos: store.getState().repos.filter((item) => item.id !== repo.id),
                worktrees: store.getState().worktrees.filter((item) => item.repoId !== repo.id),
              });
              store.dispatch({ type: "closeDialog" });
            })();
          },
        },
      });
    },
    async cloneRepo(remote) {
      const contextId = store.getState().activeContextId;
      if (!contextId) throw new SwarmError("not-found", "No context is active");
      await runOperation("Cloning repo", remote.fullName);
      patchState({
        repos: [
          ...store.getState().repos,
          {
            id: remote.fullName,
            owner: remote.owner,
            name: remote.name,
            url: remote.sshUrl,
            contextId,
            defaultBranch: remote.defaultBranch,
            path: `${config.reposDir}/${remote.owner}/${remote.name}`,
            clonedAt: new Date().toISOString(),
            hooks: { postCreate: [] },
          },
        ],
      });
      store.dispatch({ type: "closeDialog" });
    },
    async searchRemote(query, signal) {
      if (signal?.aborted) throw new SwarmError("cancelled", "Remote search cancelled");
      const state = store.getState();
      const context = state.contexts.find((item) => item.id === state.activeContextId);
      if (!context) return [];
      const normalizedQuery = query.toLowerCase();
      const cloned = new Set(state.repos.map((repo) => repo.id));
      return remotes.filter(
        (remote) =>
          context.owners.includes(remote.owner) &&
          !cloned.has(remote.fullName) &&
          remote.fullName.toLowerCase().includes(normalizedQuery),
      );
    },
    async assignRepo(repoId, contextId) {
      await runOperation("Moving repo", repoId);
      patchState({
        repos: store
          .getState()
          .repos.map((repo) => (repo.id === repoId ? { ...repo, contextId } : repo)),
      });
      store.dispatch({ type: "closeDialog" });
    },
    async saveContext(input) {
      const state = store.getState();
      const id = input.id ?? slugify(input.name);
      const existing = state.contexts.find((context) => context.id === id);
      const next = existing
        ? state.contexts.map((context) =>
            context.id === id ? { ...context, name: input.name, owners: input.owners } : context,
          )
        : [
            ...state.contexts,
            { id, name: input.name, owners: input.owners, createdAt: new Date().toISOString() },
          ];
      patchState({ contexts: next, activeContextId: id });
      store.dispatch({ type: "closeDialog" });
    },
    async deleteContext(id: ContextId) {
      const context = store.getState().contexts.find((item) => item.id === id);
      if (!context) throw new SwarmError("not-found", `Context not found: ${id}`);
      store.dispatch({
        type: "openDialog",
        dialog: {
          kind: "confirm",
          title: "Delete context?",
          body: [context.name, "All repos and worktrees in this context will be deleted"],
          danger: true,
          confirmLabel: "Delete",
          onConfirm: () => {
            void (async () => {
              await runOperation("Deleting context", id);
              const repoIds = new Set(
                store
                  .getState()
                  .repos.filter((repo) => repo.contextId === id)
                  .map((repo) => repo.id),
              );
              const contexts = store.getState().contexts.filter((item) => item.id !== id);
              patchState({
                contexts,
                repos: store.getState().repos.filter((repo) => !repoIds.has(repo.id)),
                worktrees: store
                  .getState()
                  .worktrees.filter((worktree) => !repoIds.has(worktree.repoId)),
                activeContextId: contexts[0]?.id,
              });
              store.dispatch({ type: "closeDialog" });
            })();
          },
        },
      });
    },
    async saveConfig(patch) {
      config = { ...config, ...patch };
      store.dispatch({ type: "setConfig", config });
      store.dispatch({ type: "closeDialog" });
    },
    getConfig() {
      return config;
    },
    async yankPath() {
      const worktree = requireWorktree();
      yankedPaths.push(worktree.path);
      store.dispatch({
        type: "toast",
        toast: { id: `yank-${worktree.id}`, level: "success", text: "Path copied" },
      });
    },
    async openPrs() {
      store.dispatch({ type: "setPrTab", tab: "mine" });
      store.dispatch({ type: "setScreen", screen: "prs", scope: { kind: "all" }, cursor: 0 });
    },
    async refreshPrs() {},
    async update() {
      await runOperation("Updating swarm", "swarm:update");
    },
    async openSelectedPr() {
      const pr = selectedPr(store.getState());
      if (!pr) throw new SwarmError("not-found", "No pull request is selected");
    },
    async browseSelectedPr() {
      const pr = selectedPr(store.getState());
      if (!pr) throw new SwarmError("not-found", "No pull request is selected");
      browsedPrUrls.push(pr.url);
    },
    async browseSelectedWorktreePr() {
      const state = store.getState();
      if (state.pane !== "worktrees") return;
      const worktree = selectedWorktree(state);
      if (!worktree) return;
      const pr = worktreePr(state, worktree);
      if (pr) browsedPrUrls.push(pr.url);
    },
    async yankSelectedPr() {
      const pr = selectedPr(store.getState());
      if (!pr) throw new SwarmError("not-found", "No pull request is selected");
      yankedPrUrls.push(pr.url);
    },
    backToMain() {
      store.dispatch({ type: "setScreen", screen: "main" });
    },
    setPrTab(tab) {
      store.dispatch({ type: "setPrTab", tab });
    },
    dispose() {
      disposed = true;
    },
  };

  return controller;
}
