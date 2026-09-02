import type { AppState, Selectors } from "../core/app.ts";
import { fuzzyFilter } from "../core/fuzzy.ts";
import type { CloneJob, Repo, Worktree } from "../core/types.ts";

export type RepoListItem = Repo | CloneJob;

export function isCloneJob(item: RepoListItem): item is CloneJob {
  return "status" in item;
}

function compareNames(left: RepoListItem, right: RepoListItem): number {
  return left.name.localeCompare(right.name) || left.owner.localeCompare(right.owner);
}

function openedAt(worktree: Worktree): number {
  return Date.parse(worktree.lastOpenedAt ?? worktree.createdAt);
}

export function visibleRepos(state: AppState): Repo[] {
  if (!state.activeContextId) return [];
  return state.repos.filter((repo) => repo.contextId === state.activeContextId).sort(compareNames);
}

export function visibleRepoItems(state: AppState): RepoListItem[] {
  if (!state.activeContextId) return [];
  return [...state.repos, ...state.clones]
    .filter((item) => item.contextId === state.activeContextId)
    .sort(compareNames);
}

export function selectedRepoItem(state: AppState): RepoListItem | undefined {
  if (state.repoCursor === 0) return undefined;
  return visibleRepoItems(state)[state.repoCursor - 1];
}

export function selectedRepo(state: AppState): Repo | undefined {
  const item = selectedRepoItem(state);
  return item && !isCloneJob(item) ? item : undefined;
}

export function selectedClone(state: AppState): CloneJob | undefined {
  const item = selectedRepoItem(state);
  return item && isCloneJob(item) ? item : undefined;
}

export function visibleWorktrees(state: AppState): Worktree[] {
  const contextRepoIds = new Set(visibleRepos(state).map((repo) => repo.id));
  const item = selectedRepoItem(state);
  const repo = item && !isCloneJob(item) ? item : undefined;
  const worktrees = state.worktrees
    .filter((worktree) => contextRepoIds.has(worktree.repoId))
    .filter((worktree) => item === undefined || worktree.repoId === repo?.id)
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
