import type { GithubPort } from "../core/ports.ts";
import type { RemoteRepo } from "../core/types.ts";

export type FakeGithub = GithubPort & {
  calls: Array<{ method: keyof GithubPort; args: unknown[] }>;
  reposByOwner: Map<string, RemoteRepo[]>;
};

export function createFakeGithub(
  reposByOwner: Record<string, RemoteRepo[]> = {},
  viewerLogin = "test",
): FakeGithub {
  const calls: FakeGithub["calls"] = [];
  const repos = new Map(
    Object.entries(reposByOwner).map(([owner, items]) => [
      owner,
      items.map((item) => ({ ...item })),
    ]),
  );

  return {
    calls,
    reposByOwner: repos,
    async viewer() {
      calls.push({ method: "viewer", args: [] });
      return { login: viewerLogin };
    },
    async listRepos(owner, opts) {
      calls.push({ method: "listRepos", args: [owner, opts] });
      return (repos.get(owner) ?? []).map((item) => ({ ...item }));
    },
  };
}
