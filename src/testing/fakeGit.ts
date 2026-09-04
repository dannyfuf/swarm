import type { GitPort } from "../core/ports.ts";

export interface FakeGitOptions {
  detachedPid?: number;
  defaultBranches?: Record<string, string>;
  remoteBranches?: Record<string, string[]>;
  currentBranches?: Record<string, string>;
  dirtyPaths?: string[];
  revisions?: Record<string, Record<string, string>>;
  upstreams?: Record<string, { ref: string | null; gone: boolean }>;
  aheadBehind?: Record<string, { ahead: number; behind: number }>;
  commitCounts?: Record<string, number>;
  existingRefs?: Record<string, string[]>;
  ancestors?: Record<string, boolean>;
}

export type FakeGitCall = { method: keyof GitPort; args: unknown[] };

export type FakeGit = GitPort & {
  calls: FakeGitCall[];
  defaultBranches: Map<string, string>;
  branches: Map<string, string[]>;
  currentBranches: Map<string, string>;
  dirtyPaths: Set<string>;
  revisions: Map<string, Map<string, string>>;
  upstreams: Map<string, { ref: string | null; gone: boolean }>;
  aheadBehindByPath: Map<string, { ahead: number; behind: number }>;
  commitCounts: Map<string, number>;
  existingRefs: Map<string, Set<string>>;
  ancestors: Map<string, boolean>;
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
  const upstreams = new Map(Object.entries(options.upstreams ?? {}));
  const aheadBehindByPath = new Map(Object.entries(options.aheadBehind ?? {}));
  const commitCounts = new Map(Object.entries(options.commitCounts ?? {}));
  const existingRefs = new Map(
    Object.entries(options.existingRefs ?? {}).map(([path, refs]) => [path, new Set(refs)]),
  );
  const ancestors = new Map(Object.entries(options.ancestors ?? {}));

  return {
    calls,
    defaultBranches,
    branches,
    currentBranches,
    dirtyPaths,
    revisions,
    upstreams,
    aheadBehindByPath,
    commitCounts,
    existingRefs,
    ancestors,
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
    async upstream(path) {
      calls.push({ method: "upstream", args: [path] });
      return structuredClone(
        upstreams.get(path) ?? upstreams.get(canonicalPath(path)) ?? { ref: null, gone: false },
      );
    },
    async aheadBehind(path, upstream) {
      calls.push({ method: "aheadBehind", args: [path, upstream] });
      return structuredClone(
        aheadBehindByPath.get(path) ??
          aheadBehindByPath.get(canonicalPath(path)) ?? { ahead: 0, behind: 0 },
      );
    },
    async commitCount(path, range) {
      calls.push({ method: "commitCount", args: [path, range] });
      return commitCounts.get(path) ?? commitCounts.get(canonicalPath(path)) ?? 0;
    },
    async refExists(path, ref) {
      calls.push({ method: "refExists", args: [path, ref] });
      return (
        existingRefs.get(path)?.has(ref) ?? existingRefs.get(canonicalPath(path))?.has(ref) ?? false
      );
    },
    async isAncestor(path, ancestor, descendant) {
      calls.push({ method: "isAncestor", args: [path, ancestor, descendant] });
      return (
        ancestors.get(JSON.stringify([path, ancestor, descendant])) ??
        ancestors.get(JSON.stringify([canonicalPath(path), ancestor, descendant])) ??
        false
      );
    },
    async isDirty(path, opts) {
      calls.push({ method: "isDirty", args: [path, opts] });
      return dirtyPaths.has(path) || dirtyPaths.has(canonicalPath(path));
    },
  };
}
