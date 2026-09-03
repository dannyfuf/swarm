import { SwarmError } from "./errors.ts";
import { slugify } from "./paths.ts";
import type { PrState, PullRequest, Worktree } from "./types.ts";

export function prState(pr: PullRequest): PrState {
  if (pr.isDraft) return "draft";
  if (pr.checks === "fail") return "ci_fail";
  if (pr.reviewDecision === "changes_requested") return "changes";
  if (pr.checks === "pending") return "ci_pending";
  if (pr.reviewDecision === "approved") return "approved";
  return "review";
}

export function prStateLabel(state: PrState): string {
  switch (state) {
    case "draft":
      return "draft";
    case "ci_fail":
      return "ci ✗";
    case "changes":
      return "changes";
    case "ci_pending":
      return "ci …";
    case "approved":
      return "approved";
    case "review":
      return "review";
  }
}

export function matchPrWorktree(pr: PullRequest, worktrees: Worktree[]): Worktree | undefined {
  const pullRef = `pull/${pr.number}/head`;
  return worktrees.find(
    (worktree) =>
      worktree.repoId === pr.repoId &&
      (worktree.baseRef === pullRef ||
        (!pr.isCrossRepository && worktree.branch === pr.headRefName)),
  );
}

export function prLocalBranch(pr: PullRequest): string {
  return pr.isCrossRepository ? `pr/${pr.number}` : pr.headRefName;
}

export function prBaseRef(pr: PullRequest): string | undefined {
  return pr.isCrossRepository ? `pull/${pr.number}/head` : undefined;
}

export function validateBranch(branch: string): void {
  if (slugify(branch).startsWith(".hot")) {
    throw new SwarmError("validation", `Branch name is reserved for prepared copies: ${branch}`);
  }
  const components = branch.split("/");
  const invalid =
    branch.length === 0 ||
    branch === "@" ||
    branch.startsWith("-") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    components.some(
      (component) =>
        component.length === 0 || component.startsWith(".") || component.endsWith(".lock"),
    ) ||
    [...branch].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f;
    }) ||
    branch.includes("..") ||
    branch.includes("@{") ||
    /[~^:?*]/u.test(branch) ||
    branch.includes("[") ||
    branch.includes("\\");
  if (invalid) throw new SwarmError("validation", `Invalid branch name: ${branch}`);
}
