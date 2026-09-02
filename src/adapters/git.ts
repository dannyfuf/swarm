import { SwarmError } from "../core/errors.ts";
import type { GitPort, Logger, RunOptions, Shell, ShellResult } from "../core/ports.ts";
import { validateBranch } from "../core/prs.ts";

function commandLabel(args: string[]): string {
  return `git ${args.join(" ")}`;
}

function gitError(args: string[], stderr: string, cause?: unknown): SwarmError {
  const detail =
    stderr.trim() || (cause instanceof Error ? cause.message : String(cause ?? "unknown error"));
  return new SwarmError("git", `${commandLabel(args)} failed: ${detail}`, { cause });
}

export function createGit(shell: Shell, logger: Logger): GitPort {
  const log = logger.child("git");

  const attempt = async (args: string[], opts?: RunOptions): Promise<ShellResult> => {
    try {
      return await shell.run("git", args, opts);
    } catch (error) {
      const wrapped = gitError(args, "", error);
      log.error(wrapped.message);
      throw wrapped;
    }
  };

  const run = async (args: string[], opts?: RunOptions): Promise<ShellResult> => {
    const result = await attempt(args, opts);
    if (result.code !== 0) {
      const error = gitError(args, result.stderr);
      log.error(error.message, { code: result.code });
      throw error;
    }
    return result;
  };

  const symbolicDefaultBranch = async (repoPath: string): Promise<string | null> => {
    const result = await attempt(["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: repoPath });
    if (result.code !== 0) return null;
    const ref = result.stdout.trim();
    const prefix = "refs/remotes/origin/";
    return ref.startsWith(prefix) && ref.length > prefix.length ? ref.slice(prefix.length) : null;
  };

  return {
    async cloneDetached(url, dest, logPath): Promise<number> {
      try {
        return await shell.spawnDetached("git", ["clone", "--progress", url, dest], { logPath });
      } catch (error) {
        const wrapped = gitError(["clone", "--progress", url, dest], "", error);
        log.error(wrapped.message);
        throw wrapped;
      }
    },

    async fetch(repoPath, opts): Promise<void> {
      await run(["fetch", ...(opts?.prune ? ["--prune"] : []), "origin"], {
        cwd: repoPath,
        signal: opts?.signal,
      });
    },

    async defaultBranch(repoPath): Promise<string> {
      const existing = await symbolicDefaultBranch(repoPath);
      if (existing) return existing;

      await attempt(["remote", "set-head", "origin", "--auto"], { cwd: repoPath });
      const refreshed = await symbolicDefaultBranch(repoPath);
      if (refreshed) return refreshed;

      const main = await attempt(["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"], {
        cwd: repoPath,
      });
      return main.code === 0 ? "main" : "master";
    },

    async resetToRemote(repoPath, branch): Promise<void> {
      const remote = `origin/${branch}`;
      await run(["checkout", "-B", branch, remote], { cwd: repoPath });
      await run(["reset", "--hard", remote], { cwd: repoPath });
      await run(["clean", "-fd"], { cwd: repoPath });
    },

    async checkoutNewBranch(path, branch, from): Promise<void> {
      await run(["checkout", "-b", branch, from], { cwd: path });
    },

    async checkoutTracking(path, branch): Promise<void> {
      await run(["checkout", branch], { cwd: path });
    },

    async fetchPullHead(path, number, localBranch): Promise<void> {
      if (!Number.isInteger(number) || number <= 0) {
        throw new SwarmError("validation", `Invalid pull request number: ${number}`);
      }
      validateBranch(localBranch);
      await run(["fetch", "origin", `+refs/pull/${number}/head:refs/heads/${localBranch}`], {
        cwd: path,
      });
    },

    async remoteBranches(repoPath): Promise<string[]> {
      const result = await run(
        ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"],
        { cwd: repoPath },
      );
      return result.stdout
        .split(/\r?\n/)
        .map((branch) => branch.trim())
        .filter((branch) => branch.length > 0 && branch !== "origin/HEAD" && branch !== "origin");
    },

    async currentBranch(path): Promise<string> {
      const result = await run(["branch", "--show-current"], { cwd: path });
      return result.stdout.trim();
    },

    async isDirty(path, opts): Promise<boolean> {
      const result = await run(["status", "--porcelain", "--untracked-files=normal"], {
        cwd: path,
        signal: opts?.signal,
      });
      return result.stdout.length > 0;
    },
  };
}
