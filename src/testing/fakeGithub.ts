import type { GithubPort } from "../core/ports.ts";
import type { PrTab, PullRequest, RemoteRepo } from "../core/types.ts";

export type FakeGithub = GithubPort & {
  calls: Array<{ method: keyof GithubPort; args: unknown[] }>;
  reposByOwner: Map<string, RemoteRepo[]>;
  prsByRepoTab: Map<string, PullRequest[]>;
  prCacheByRepoTab: Map<string, { prs: PullRequest[]; fetchedAt: string; stale: boolean }>;
  prErrors: Map<string, Error>;
};

export interface FakeGithubOptions {
  reposByOwner?: Record<string, RemoteRepo[]>;
  prsByRepoTab?: Record<string, PullRequest[]>;
  prCacheByRepoTab?: Record<string, { prs: PullRequest[]; fetchedAt: string; stale: boolean }>;
  prErrors?: Record<string, Error>;
  viewerLogin?: string;
}

function prKey(repoId: string, tab: PrTab): string {
  return `${repoId}:${tab}`;
}

function isOptions(
  input: Record<string, RemoteRepo[]> | FakeGithubOptions,
): input is FakeGithubOptions {
  return (
    "reposByOwner" in input ||
    "prsByRepoTab" in input ||
    "prCacheByRepoTab" in input ||
    "prErrors" in input ||
    "viewerLogin" in input
  );
}

export function createFakeGithub(
  input: Record<string, RemoteRepo[]> | FakeGithubOptions = {},
  legacyViewerLogin = "test",
): FakeGithub {
  const options: FakeGithubOptions = isOptions(input)
    ? input
    : { reposByOwner: input, viewerLogin: legacyViewerLogin };
  const calls: FakeGithub["calls"] = [];
  const repos = new Map(
    Object.entries(options.reposByOwner ?? {}).map(([owner, items]) => [
      owner,
      items.map((item) => ({ ...item })),
    ]),
  );
  const prs = new Map(
    Object.entries(options.prsByRepoTab ?? {}).map(([key, items]) => [
      key,
      items.map((item) => ({ ...item, labels: [...item.labels] })),
    ]),
  );
  const prErrors = new Map(Object.entries(options.prErrors ?? {}));
  const prCache = new Map(
    Object.entries(options.prCacheByRepoTab ?? {}).map(([key, entry]) => [
      key,
      {
        ...entry,
        prs: entry.prs.map((item) => ({ ...item, labels: [...item.labels] })),
      },
    ]),
  );

  return {
    calls,
    reposByOwner: repos,
    prsByRepoTab: prs,
    prCacheByRepoTab: prCache,
    prErrors,
    async viewer() {
      calls.push({ method: "viewer", args: [] });
      return { login: options.viewerLogin ?? legacyViewerLogin };
    },
    async listRepos(owner, opts) {
      calls.push({ method: "listRepos", args: [owner, opts] });
      return (repos.get(owner) ?? []).map((item) => ({ ...item }));
    },
    async readCachedPullRequests(repo, tab, opts) {
      calls.push({ method: "readCachedPullRequests", args: [repo, tab, opts] });
      const entry = prCache.get(prKey(`${repo.owner}/${repo.name}`, tab));
      return entry
        ? {
            ...entry,
            prs: entry.prs.map((item) => ({ ...item, labels: [...item.labels] })),
          }
        : undefined;
    },
    async listPullRequests(repo, tab, opts) {
      calls.push({ method: "listPullRequests", args: [repo, tab, opts] });
      const repoId = `${repo.owner}/${repo.name}`;
      const key = prKey(repoId, tab);
      const error = prErrors.get(key) ?? prErrors.get(repoId);
      if (error) throw error;
      return {
        prs: (prs.get(key) ?? []).map((item) => ({ ...item, labels: [...item.labels] })),
        fetchedAt: "2026-01-01T00:00:00.000Z",
      };
    },
  };
}
