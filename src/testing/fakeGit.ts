import type { GitPort } from "../core/ports.ts";

export interface FakeGitOptions {
  detachedPid?: number;
  defaultBranches?: Record<string, string>;
  remoteBranches?: Record<string, string[]>;
  currentBranches?: Record<string, string>;
  dirtyPaths?: string[];
}

export type FakeGitCall = { method: keyof GitPort; args: unknown[] };

export type FakeGit = GitPort & {
  calls: FakeGitCall[];
  defaultBranches: Map<string, string>;
  branches: Map<string, string[]>;
  currentBranches: Map<string, string>;
  dirtyPaths: Set<string>;
};

export function createFakeGit(options: FakeGitOptions = {}): FakeGit {
  const calls: FakeGitCall[] = [];
  const defaultBranches = new Map(Object.entries(options.defaultBranches ?? {}));
  const branches = new Map(
    Object.entries(options.remoteBranches ?? {}).map(([path, values]) => [path, [...values]]),
  );
  const currentBranches = new Map(Object.entries(options.currentBranches ?? {}));
  const dirtyPaths = new Set(options.dirtyPaths ?? []);

  return {
    calls,
    defaultBranches,
    branches,
    currentBranches,
    dirtyPaths,
    async cloneDetached(url, dest, logPath) {
      calls.push({ method: "cloneDetached", args: [url, dest, logPath] });
      return options.detachedPid ?? 4242;
    },
    async fetch(repoPath, opts) {
      calls.push({ method: "fetch", args: [repoPath, opts] });
    },
    async defaultBranch(repoPath) {
      calls.push({ method: "defaultBranch", args: [repoPath] });
      return defaultBranches.get(repoPath) ?? "main";
    },
    async resetToRemote(repoPath, branch) {
      calls.push({ method: "resetToRemote", args: [repoPath, branch] });
      currentBranches.set(repoPath, branch);
      dirtyPaths.delete(repoPath);
    },
    async checkoutNewBranch(path, branch, from) {
      calls.push({ method: "checkoutNewBranch", args: [path, branch, from] });
      currentBranches.set(path, branch);
    },
    async checkoutTracking(path, branch) {
      calls.push({ method: "checkoutTracking", args: [path, branch] });
      currentBranches.set(path, branch.replace(/^origin\//, ""));
    },
    async fetchPullHead(path, number, localBranch) {
      calls.push({ method: "fetchPullHead", args: [path, number, localBranch] });
      currentBranches.set(path, localBranch);
    },
    async remoteBranches(repoPath) {
      calls.push({ method: "remoteBranches", args: [repoPath] });
      return [...(branches.get(repoPath) ?? [])];
    },
    async currentBranch(path) {
      calls.push({ method: "currentBranch", args: [path] });
      return currentBranches.get(path) ?? "main";
    },
    async isDirty(path, opts) {
      calls.push({ method: "isDirty", args: [path, opts] });
      return dirtyPaths.has(path);
    },
  };
}
