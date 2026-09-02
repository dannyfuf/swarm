import { join } from "node:path";
import { z } from "zod";
import { SwarmError } from "../core/errors.ts";
import type { Clock, FilesPort, GithubPort, Logger, Shell, ShellResult } from "../core/ports.ts";
import {
  type PrChecks,
  type PrReviewDecision,
  type PullRequest,
  PullRequestSchema,
  type RemoteRepo,
} from "../core/types.ts";

const RemoteRepoSchema = z.object({
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  description: z.string(),
  sshUrl: z.string(),
  isPrivate: z.boolean(),
  updatedAt: z.string(),
  defaultBranch: z.string(),
});

const RepoCacheSchema = z.object({
  fetchedAt: z.string(),
  repos: z.array(RemoteRepoSchema),
});

const GithubRepoSchema = z.object({
  name: z.string(),
  owner: z.object({ login: z.string() }),
  nameWithOwner: z.string(),
  description: z.string().nullable(),
  sshUrl: z.string(),
  isPrivate: z.boolean(),
  updatedAt: z.string(),
  defaultBranchRef: z.object({ name: z.string() }).nullable().optional(),
});

const GithubReposSchema = z.array(GithubRepoSchema);

const GithubPullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string().url(),
  author: z
    .object({ login: z.string().min(1) })
    .nullable()
    .optional(),
  headRefName: z.string().min(1),
  baseRefName: z.string().min(1),
  isDraft: z.boolean(),
  isCrossRepository: z.boolean(),
  headRepository: z
    .object({ name: z.string().optional(), nameWithOwner: z.string().optional() })
    .nullable()
    .optional(),
  headRepositoryOwner: z.object({ login: z.string() }).nullable().optional(),
  reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", ""]).nullable(),
  statusCheckRollup: z.array(
    z.object({
      conclusion: z.string().nullable().optional(),
      state: z.string().nullable().optional(),
      status: z.string().nullable().optional(),
    }),
  ),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  labels: z.array(z.object({ name: z.string() })),
  updatedAt: z.string().datetime(),
});

const GithubPullRequestsSchema = z.array(GithubPullRequestSchema);
const PrCacheSchema = z.object({
  fetchedAt: z.string().datetime(),
  prs: z.array(PullRequestSchema),
});

const PR_FIELDS =
  "number,title,url,author,headRefName,baseRefName,isDraft,isCrossRepository,headRepository,headRepositoryOwner,reviewDecision,statusCheckRollup,additions,deletions,labels,updatedAt";

interface GithubListOptions {
  signal?: AbortSignal;
  force?: boolean;
}

export interface GithubAdapter extends GithubPort {
  listRepos(owner: string, opts?: GithubListOptions): Promise<RemoteRepo[]>;
}

interface CacheEntry {
  fetchedAt: string;
  repos: RemoteRepo[];
}

interface PrCacheEntry {
  fetchedAt: string;
  prs: PullRequest[];
}

function githubFailure(action: string, result: ShellResult, cause?: unknown): SwarmError {
  const detail = result.stderr.trim();
  const suffix = detail ? ` (${detail})` : "";
  return new SwarmError(
    "github",
    `${action}${suffix}. Authenticate with \`gh auth login\` and try again.`,
    { cause },
  );
}

function isFresh(entry: { fetchedAt: string }, now: Date, ttlSeconds: number): boolean {
  const fetchedAt = Date.parse(entry.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return false;
  return now.getTime() - fetchedAt < ttlSeconds * 1000;
}

function parseCache(text: string, cachePath: string, logger: Logger): CacheEntry | undefined {
  try {
    return RepoCacheSchema.parse(JSON.parse(text));
  } catch (error) {
    logger.warn("Ignoring invalid GitHub repository cache", { path: cachePath, error });
    return undefined;
  }
}

function parsePrCache(text: string, cachePath: string, logger: Logger): PrCacheEntry | undefined {
  try {
    return PrCacheSchema.parse(JSON.parse(text));
  } catch (error) {
    logger.warn("Ignoring invalid GitHub pull request cache", { path: cachePath, error });
    return undefined;
  }
}

function reviewDecision(value: string | null): PrReviewDecision {
  switch (value) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
    default:
      return "none";
  }
}

function checks(
  rollup: Array<{ conclusion?: string | null; state?: string | null; status?: string | null }>,
): PrChecks {
  if (rollup.length === 0) return "none";
  const failures = new Set([
    "FAILURE",
    "ERROR",
    "TIMED_OUT",
    "CANCELLED",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
  ]);
  const passing = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  const pending = new Set([
    "PENDING",
    "IN_PROGRESS",
    "QUEUED",
    "EXPECTED",
    "REQUESTED",
    "WAITING",
    "STALE",
  ]);

  let allPassing = true;
  for (const item of rollup) {
    const values = [item.conclusion, item.state, item.status]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .map((value) => value.toUpperCase());
    if (values.some((value) => failures.has(value))) return "fail";
    if (values.some((value) => pending.has(value))) {
      allPassing = false;
      continue;
    }
    if (!values.some((value) => passing.has(value))) allPassing = false;
  }
  return allPassing ? "pass" : "pending";
}

function mapPullRequests(stdout: string, repoId: string): PullRequest[] {
  try {
    return GithubPullRequestsSchema.parse(JSON.parse(stdout)).map((pr) => {
      const headRepo =
        pr.headRepository?.nameWithOwner ??
        (pr.headRepositoryOwner?.login && pr.headRepository?.name
          ? `${pr.headRepositoryOwner.login}/${pr.headRepository.name}`
          : undefined);
      return PullRequestSchema.parse({
        repoId,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        author: pr.author?.login ?? "ghost",
        headRefName: pr.headRefName,
        baseRefName: pr.baseRefName,
        isDraft: pr.isDraft,
        isCrossRepository: pr.isCrossRepository,
        ...(pr.isCrossRepository && headRepo ? { headRepo } : {}),
        reviewDecision: reviewDecision(pr.reviewDecision),
        checks: checks(pr.statusCheckRollup),
        additions: pr.additions,
        deletions: pr.deletions,
        labels: pr.labels.map(({ name }) => name),
        updatedAt: pr.updatedAt,
      });
    });
  } catch (cause) {
    throw new SwarmError(
      "github",
      `GitHub returned invalid pull request data for ${repoId}. Authenticate with \`gh auth login\` and try again.`,
      { cause },
    );
  }
}

function mapRepos(stdout: string, owner: string): RemoteRepo[] {
  try {
    return GithubReposSchema.parse(JSON.parse(stdout)).map((repo) => ({
      owner: repo.owner.login,
      name: repo.name,
      fullName: repo.nameWithOwner,
      description: repo.description ?? "",
      sshUrl: repo.sshUrl,
      isPrivate: repo.isPrivate,
      updatedAt: repo.updatedAt,
      defaultBranch: repo.defaultBranchRef?.name ?? "main",
    }));
  } catch (cause) {
    throw new SwarmError(
      "github",
      `GitHub returned invalid repository data for ${owner}. Authenticate with \`gh auth login\` and try again.`,
      { cause },
    );
  }
}

export function createGithub(
  shell: Shell,
  files: FilesPort,
  logger: Logger,
  options: { cacheDir: string; cacheTtlSeconds: number; clock: Clock },
): GithubAdapter {
  return {
    async viewer() {
      let result: ShellResult;
      try {
        result = await shell.run("gh", ["api", "user", "--jq", ".login"]);
      } catch (cause) {
        throw githubFailure(
          "Unable to identify the GitHub viewer",
          {
            code: 1,
            stdout: "",
            stderr: cause instanceof Error ? cause.message : "",
          },
          cause,
        );
      }

      const login = result.stdout.trim();
      if (result.code !== 0 || !login) {
        throw githubFailure("Unable to identify the GitHub viewer", result);
      }
      return { login };
    },

    async listRepos(owner, opts = {}) {
      const cachePath = join(options.cacheDir, `${owner}.json`);
      const cacheText = await files.readText(cachePath);
      const cached = cacheText === null ? undefined : parseCache(cacheText, cachePath, logger);

      if (!opts.force && cached && isFresh(cached, options.clock.now(), options.cacheTtlSeconds)) {
        return cached.repos;
      }

      let result: ShellResult;
      try {
        result = await shell.run(
          "gh",
          [
            "repo",
            "list",
            owner,
            "--limit",
            "1000",
            "--json",
            "name,owner,nameWithOwner,description,sshUrl,isPrivate,updatedAt,defaultBranchRef",
          ],
          { signal: opts.signal },
        );
      } catch (cause) {
        if (opts.signal?.aborted) {
          throw new SwarmError(
            "cancelled",
            `Listing GitHub repositories for ${owner} was cancelled`,
            {
              cause,
            },
          );
        }
        result = {
          code: 1,
          stdout: "",
          stderr: cause instanceof Error ? cause.message : "",
        };
      }

      if (opts.signal?.aborted) {
        throw new SwarmError("cancelled", `Listing GitHub repositories for ${owner} was cancelled`);
      }

      if (result.code !== 0) {
        if (cached) {
          logger.warn("GitHub repository refresh failed; using cached data", {
            owner,
            stderr: result.stderr.trim(),
          });
          return cached.repos;
        }
        throw githubFailure(`Unable to list GitHub repositories for ${owner}`, result);
      }

      const repos = mapRepos(result.stdout, owner);
      const cache: CacheEntry = { fetchedAt: options.clock.now().toISOString(), repos };
      await files.ensureDir(options.cacheDir);
      await files.writeTextAtomic(cachePath, JSON.stringify(cache, null, 2));
      return repos;
    },

    async readCachedPullRequests(repo, tab, opts = {}) {
      const cachePath = join(options.cacheDir, "prs", repo.owner, repo.name, `${tab}.json`);
      const cacheText = await files.readText(cachePath);
      const cached = cacheText === null ? undefined : parsePrCache(cacheText, cachePath, logger);
      const ttlSeconds = opts.ttlSeconds ?? 90;
      if (!cached) return undefined;
      return { ...cached, stale: !isFresh(cached, options.clock.now(), ttlSeconds) };
    },

    async listPullRequests(repo, tab, opts = {}) {
      const repoId = `${repo.owner}/${repo.name}`;
      const cachePath = join(options.cacheDir, "prs", repo.owner, repo.name, `${tab}.json`);
      const qualifier = tab === "mine" ? ["--author", "@me"] : ["--search", "review-requested:@me"];
      let result: ShellResult;
      try {
        result = await shell.run(
          "gh",
          [
            "pr",
            "list",
            "--repo",
            repoId,
            "--state",
            "open",
            "--limit",
            "100",
            "--json",
            PR_FIELDS,
            ...qualifier,
          ],
          { signal: opts.signal },
        );
      } catch (cause) {
        if (opts.signal?.aborted) {
          throw new SwarmError("cancelled", `Listing pull requests for ${repoId} was cancelled`, {
            cause,
          });
        }
        result = {
          code: 1,
          stdout: "",
          stderr: cause instanceof Error ? cause.message : "",
        };
      }

      if (opts.signal?.aborted) {
        throw new SwarmError("cancelled", `Listing pull requests for ${repoId} was cancelled`);
      }
      if (result.code !== 0) {
        throw githubFailure(`Unable to list pull requests for ${repoId}`, result);
      }

      const prs = mapPullRequests(result.stdout, repoId);
      const cache: PrCacheEntry = { fetchedAt: options.clock.now().toISOString(), prs };
      await files.ensureDir(join(options.cacheDir, "prs", repo.owner, repo.name));
      await files.writeTextAtomic(cachePath, JSON.stringify(cache, null, 2));
      return cache;
    },
  };
}
