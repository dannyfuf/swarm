import type { GithubPort } from "../core/ports.ts";
import type { PrService } from "../core/services.ts";
import { type PrRepoSlice, type PrTab, RepoId } from "../core/types.ts";

export interface PrServiceDependencies {
  github: GithubPort;
  ttlSeconds: number;
}

type Task<T> = () => Promise<T>;
type Limit = <T>(task: Task<T>) => Promise<T>;

function createLimiter(maximum: number): Limit {
  let active = 0;
  const queue: Array<() => void> = [];

  const startNext = (): void => {
    while (active < maximum) {
      const start = queue.shift();
      if (!start) return;
      active += 1;
      start();
    }
  };

  return <T>(task: Task<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        void task()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            startNext();
          });
      });
      startNext();
    });
}

function errorSummary(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error))
    .split(/\r?\n/u)[0]
    ?.trim();
  const summary = message || "Unable to refresh pull requests";
  return summary.length <= 120 ? summary : `${summary.slice(0, 119)}…`;
}

function repoParts(repoId: string): { owner: string; name: string } {
  const parsed = RepoId.parse(repoId);
  const separator = parsed.indexOf("/");
  return { owner: parsed.slice(0, separator), name: parsed.slice(separator + 1) };
}

export function createPrService({ github, ttlSeconds }: PrServiceDependencies): PrService {
  const slices: Record<PrTab, Map<string, PrRepoSlice>> = {
    mine: new Map(),
    review: new Map(),
  };
  const limit = createLimiter(4);
  const generations = new Map<string, number>();
  const controllers = new Map<string, AbortController>();

  return {
    async findByBranch(repoId, branch) {
      return github.findPullRequest(repoParts(repoId), branch);
    },

    async load(repoIds, tab, opts) {
      const requests = [...new Set(repoIds)].map(async (repoId) => {
        const key = `${repoId}:${tab}`;
        const generation = (generations.get(key) ?? 0) + 1;
        generations.set(key, generation);
        controllers.get(key)?.abort();
        const controller = new AbortController();
        controllers.set(key, controller);
        const isCurrent = (): boolean => generations.get(key) === generation;
        const repo = repoParts(repoId);
        const previous = slices[tab].get(repoId) ?? { prs: [], loading: false };

        let cached: Awaited<ReturnType<GithubPort["readCachedPullRequests"]>>;
        try {
          cached = await github.readCachedPullRequests(repo, tab, { ttlSeconds });
        } catch {
          cached = undefined;
        }
        if (!isCurrent()) return;

        const refresh = opts.force === true || cached === undefined || cached.stale;
        if (cached) {
          const cacheSlice = {
            ...previous,
            prs: cached.prs,
            fetchedAt: cached.fetchedAt,
            loading: refresh,
          } satisfies PrRepoSlice;
          slices[tab].set(repoId, cacheSlice);
          opts.onSlice(repoId, cacheSlice);
          if (!refresh) {
            if (controllers.get(key) === controller) controllers.delete(key);
            return;
          }
        } else {
          const loading = { ...previous, loading: true } satisfies PrRepoSlice;
          slices[tab].set(repoId, loading);
          opts.onSlice(repoId, loading);
        }

        try {
          const result = await limit(async () => {
            if (controller.signal.aborted) return undefined;
            return github.listPullRequests(repo, tab, { signal: controller.signal });
          });
          if (!result || !isCurrent()) return;
          const final = {
            prs: result.prs,
            fetchedAt: result.fetchedAt,
            loading: false,
          } satisfies PrRepoSlice;
          slices[tab].set(repoId, final);
          opts.onSlice(repoId, final);
        } catch (error) {
          if (!isCurrent()) return;
          const latest = slices[tab].get(repoId) ?? previous;
          const final = {
            ...latest,
            error: errorSummary(error),
            loading: false,
          } satisfies PrRepoSlice;
          slices[tab].set(repoId, final);
          opts.onSlice(repoId, final);
        } finally {
          if (controllers.get(key) === controller) controllers.delete(key);
        }
      });

      await Promise.all(requests);
    },
  };
}
