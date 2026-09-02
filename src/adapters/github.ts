import { join } from "node:path";
import { z } from "zod";
import { SwarmError } from "../core/errors.ts";
import type { Clock, FilesPort, GithubPort, Logger, Shell, ShellResult } from "../core/ports.ts";
import type { RemoteRepo } from "../core/types.ts";

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

const CacheSchema = z.object({
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

function githubFailure(action: string, result: ShellResult, cause?: unknown): SwarmError {
  const detail = result.stderr.trim();
  const suffix = detail ? ` (${detail})` : "";
  return new SwarmError(
    "github",
    `${action}${suffix}. Authenticate with \`gh auth login\` and try again.`,
    { cause },
  );
}

function isFresh(entry: CacheEntry, now: Date, ttlSeconds: number): boolean {
  const fetchedAt = Date.parse(entry.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return false;
  return now.getTime() - fetchedAt < ttlSeconds * 1000;
}

function parseCache(text: string, cachePath: string, logger: Logger): CacheEntry | undefined {
  try {
    return CacheSchema.parse(JSON.parse(text));
  } catch (error) {
    logger.warn("Ignoring invalid GitHub repository cache", { path: cachePath, error });
    return undefined;
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
  };
}
