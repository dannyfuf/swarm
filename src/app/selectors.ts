import type { AppState, Selectors } from "../core/app.ts";
import { fuzzyFilter } from "../core/fuzzy.ts";
import type { Repo, Worktree } from "../core/types.ts";

function compareNames(left: Repo, right: Repo): number {
  return left.name.localeCompare(right.name) || left.owner.localeCompare(right.owner);
}

function openedAt(worktree: Worktree): number {
  return Date.parse(worktree.lastOpenedAt ?? worktree.createdAt);
}

export function visibleRepos(state: AppState): Repo[] {
  if (!state.activeContextId) return [];
  return state.repos.filter((repo) => repo.contextId === state.activeContextId).sort(compareNames);
}

export function selectedRepo(state: AppState): Repo | undefined {
  if (state.repoCursor === 0) return undefined;
  return visibleRepos(state)[state.repoCursor - 1];
}

export function visibleWorktrees(state: AppState): Worktree[] {
  const contextRepoIds = new Set(visibleRepos(state).map((repo) => repo.id));
  const repo = selectedRepo(state);
  const worktrees = state.worktrees
    .filter((worktree) => contextRepoIds.has(worktree.repoId))
    .filter((worktree) => repo === undefined || worktree.repoId === repo.id)
    .sort((left, right) => openedAt(right) - openedAt(left));

  return fuzzyFilter(state.filter, worktrees, (worktree) => worktree.branch).map(
    ({ item }) => item,
  );
}

export function selectedWorktree(state: AppState): Worktree | undefined {
  return visibleWorktrees(state)[state.worktreeCursor];
}

export const selectors: Selectors = {
  visibleRepos,
  visibleWorktrees,
  selectedRepo,
  selectedWorktree,
};
