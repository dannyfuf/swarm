import type { GitPort } from "../core/ports.ts";

export interface FakeGitOptions {
  detachedPid?: number;
  defaultBranches?: Record<string, string>;
  remoteBranches?: Record<string, string[]>;
  currentBranches?: Record<string, string>;
  dirtyPaths?: string[];
  revisions?: Record<string, Record<string, string>>;
}

export type FakeGitCall = { method: keyof GitPort; args: unknown[] };

export type FakeGit = GitPort & {
  calls: FakeGitCall[];
  defaultBranches: Map<string, string>;
  branches: Map<string, string[]>;
  currentBranches: Map<string, string>;
  dirtyPaths: Set<string>;
  revisions: Map<string, Map<string, string>>;
};

export function createFakeGit(options: FakeGitOptions = {}): FakeGit {
  const canonicalPath = (path: string): string => path.replace(/\.creating-[^/]+$/u, "");
  const calls: FakeGitCall[] = [];
  const defaultBranches = new Map(Object.entries(options.defaultBranches ?? {}));
  const branches = new Map(
    Object.entries(options.remoteBranches ?? {}).map(([path, values]) => [path, [...values]]),
  );
  const currentBranches = new Map(Object.entries(options.currentBranches ?? {}));
  const dirtyPaths = new Set(options.dirtyPaths ?? []);
  const revisions = new Map(
    Object.entries(options.revisions ?? {}).map(([path, refs]) => [
      path,
      new Map(Object.entries(refs)),
    ]),
  );

  return {
    calls,
    defaultBranches,
    branches,
    currentBranches,
    dirtyPaths,
    revisions,
    async cloneDetached(url, dest, logPath) {
      calls.push({ method: "cloneDetached", args: [url, dest, logPath] });
      return options.detachedPid ?? 4242;
    },
    async fetch(repoPath, opts) {
      calls.push({ method: "fetch", args: [repoPath, opts] });
    },
    async fetchRefs(repoPath, remote, refs, signal) {
      calls.push({ method: "fetchRefs", args: [repoPath, remote, refs, signal] });
    },
    async defaultBranch(repoPath, hint, signal, knownRemoteBranches) {
      calls.push({
        method: "defaultBranch",
        args: [repoPath, hint, signal, knownRemoteBranches],
      });
      return (
        defaultBranches.get(repoPath) ??
        defaultBranches.get(canonicalPath(repoPath)) ??
        hint ??
        "main"
      );
    },
    async resetToRemote(repoPath, branch, signal) {
      calls.push({ method: "resetToRemote", args: [repoPath, branch, signal] });
      currentBranches.set(repoPath, branch);
      dirtyPaths.delete(repoPath);
      const pathRevisions =
        revisions.get(repoPath) ??
        revisions.get(canonicalPath(repoPath)) ??
        new Map<string, string>();
      pathRevisions.set("HEAD", pathRevisions.get(`origin/${branch}`) ?? "2".repeat(40));
      revisions.set(repoPath, pathRevisions);
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
    async remoteBranches(repoPath, signal) {
      calls.push({ method: "remoteBranches", args: [repoPath, signal] });
      return [...(branches.get(repoPath) ?? branches.get(canonicalPath(repoPath)) ?? [])];
    },
    async revision(path, ref, signal) {
      calls.push({ method: "revision", args: [path, ref, signal] });
      return (
        revisions.get(path)?.get(ref) ??
        revisions.get(canonicalPath(path))?.get(ref) ??
        (ref === "HEAD" ? "1" : "2").repeat(40)
      );
    },
    async currentBranch(path) {
      calls.push({ method: "currentBranch", args: [path] });
      return currentBranches.get(path) ?? currentBranches.get(canonicalPath(path)) ?? "main";
    },
    async isDirty(path, opts) {
      calls.push({ method: "isDirty", args: [path, opts] });
      return dirtyPaths.has(path) || dirtyPaths.has(canonicalPath(path));
    },
  };
}
