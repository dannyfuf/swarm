import type { AppState, Selectors } from "../core/app.ts";
import { fuzzyFilter } from "../core/fuzzy.ts";
import { matchPrWorktree } from "../core/prs.ts";
import type { CloneJob, PrTab, PullRequest, Repo, RepoId, Worktree } from "../core/types.ts";

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

/** Repos the PR screen currently looks at: the whole context, or one repo. */
export function prScopeRepoIds(state: AppState): RepoId[] {
  const contextIds = new Set(visibleRepos(state).map(({ id }) => id));
  if (state.prScope.kind === "repo") {
    return contextIds.has(state.prScope.repoId) ? [state.prScope.repoId] : [];
  }
  return [...contextIds];
}

function comparePrs(left: PullRequest, right: PullRequest): number {
  return (
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
    left.repoId.localeCompare(right.repoId) ||
    right.number - left.number
  );
}

function prKey(pr: PullRequest): string {
  return `${pr.repoId}#${pr.number}`;
}

export function prsInScope(state: AppState, tab: PrTab): PullRequest[] {
  const repoIds = prScopeRepoIds(state);
  const authored =
    tab === "review"
      ? new Set(repoIds.flatMap((repoId) => (state.prs.mine[repoId]?.prs ?? []).map(prKey)))
      : undefined;
  const prs = repoIds
    .flatMap((repoId) => state.prs[tab][repoId]?.prs ?? [])
    .filter((pr) => !authored?.has(prKey(pr)));
  const filtered = state.prFilter
    ? fuzzyFilter(
        state.prFilter,
        prs,
        (pr) => `#${pr.number} ${pr.title} ${pr.headRefName} ${pr.author}`,
      ).map(({ item }) => item)
    : prs;
  return filtered.sort(comparePrs);
}

export function prErrorsInScope(
  state: AppState,
  tab: PrTab,
): Array<{ repoId: RepoId; error: string }> {
  return prScopeRepoIds(state)
    .flatMap((repoId) => {
      const error = state.prs[tab][repoId]?.error;
      return error ? [{ repoId, error }] : [];
    })
    .sort((left, right) => left.repoId.localeCompare(right.repoId));
}

export function prLoadingInScope(state: AppState, tab: PrTab): boolean {
  return prScopeRepoIds(state).some((repoId) => state.prs[tab][repoId]?.loading === true);
}

export function selectedPr(state: AppState): PullRequest | undefined {
  return prsInScope(state, state.prTab)[state.prCursor];
}

export function prWorktree(state: AppState, pr: PullRequest): Worktree | undefined {
  return matchPrWorktree(pr, state.worktrees);
}

export function worktreePr(state: AppState, worktree: Worktree): PullRequest | undefined {
  return Object.values(state.prs.mine)
    .flatMap(({ prs }) => prs)
    .find((pr) => matchPrWorktree(pr, [worktree]) !== undefined);
}

export function reviewCount(state: AppState): number {
  return prsInScope({ ...state, prScope: { kind: "all" }, prFilter: "" }, "review").length;
}

export function prHints(state: AppState): Array<{ key: string; label: string }> {
  const pr = selectedPr(state);
  const linked = pr ? prWorktree(state, pr) : undefined;
  return [
    ...(pr
      ? [
          { key: "Enter", label: linked ? "open" : "create worktree" },
          { key: "O", label: linked ? "open, keep previous" : "create, keep previous" },
          { key: "b", label: "browser" },
          { key: "y", label: "copy url" },
        ]
      : []),
    { key: "/", label: "filter" },
    { key: "r", label: "refresh" },
    { key: "Tab", label: "switch tab" },
    { key: "Esc", label: "back" },
    { key: "?", label: "help" },
  ];
}

export const selectors: Selectors = {
  visibleRepos,
  visibleWorktrees,
  selectedRepo,
  selectedWorktree,
  prsInScope,
  prErrorsInScope,
  prLoadingInScope,
  selectedPr,
  prWorktree,
  worktreePr,
  reviewCount,
  prHints,
};
