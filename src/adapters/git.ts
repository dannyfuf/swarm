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

  const symbolicDefaultBranch = async (
    repoPath: string,
    signal?: AbortSignal,
  ): Promise<string | null> => {
    const result = await attempt(["symbolic-ref", "refs/remotes/origin/HEAD"], {
      cwd: repoPath,
      signal,
    });
    if (result.code !== 0) return null;
    const ref = result.stdout.trim();
    const prefix = "refs/remotes/origin/";
    return ref.startsWith(prefix) && ref.length > prefix.length ? ref.slice(prefix.length) : null;
  };

  const remoteBranchExists = async (
    repoPath: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const result = await attempt(
      ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
      { cwd: repoPath, signal },
    );
    return result.code === 0;
  };

  const listRemoteBranches = async (repoPath: string, signal?: AbortSignal): Promise<string[]> => {
    const result = await run(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"], {
      cwd: repoPath,
      signal,
    });
    return result.stdout
      .split(/\r?\n/)
      .map((branch) => branch.trim())
      .filter((branch) => branch.length > 0 && branch !== "origin/HEAD" && branch !== "origin");
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

    async fetchRefs(repoPath, remote, refs, signal): Promise<void> {
      await run(["fetch", remote, ...refs], { cwd: repoPath, signal });
    },

    async defaultBranch(repoPath, hint, signal, knownRemoteBranches): Promise<string> {
      const existing = await symbolicDefaultBranch(repoPath, signal);
      const targetExists = async (branch: string): Promise<boolean> =>
        knownRemoteBranches !== undefined
          ? knownRemoteBranches.includes(`origin/${branch}`)
          : remoteBranchExists(repoPath, branch, signal);
      if (existing && (await targetExists(existing))) return existing;

      await attempt(["remote", "set-head", "origin", "--auto"], { cwd: repoPath, signal });
      const refreshed = await symbolicDefaultBranch(repoPath, signal);
      if (refreshed && (await targetExists(refreshed))) return refreshed;

      if (hint && (await remoteBranchExists(repoPath, hint, signal))) return hint;
      if (hint !== "main" && (await remoteBranchExists(repoPath, "main", signal))) return "main";
      if (hint !== "master" && (await remoteBranchExists(repoPath, "master", signal))) {
        return "master";
      }

      const remoteBranches = knownRemoteBranches ?? (await listRemoteBranches(repoPath, signal));
      if (remoteBranches.length > 0) return remoteBranches[0]?.slice("origin/".length) ?? "main";
      if (hint) return hint;

      const localHead = await attempt(["symbolic-ref", "--short", "HEAD"], {
        cwd: repoPath,
        signal,
      });
      return localHead.code === 0 && localHead.stdout.trim().length > 0
        ? localHead.stdout.trim()
        : "main";
    },

    async resetToRemote(repoPath, branch, signal): Promise<void> {
      const remote = `origin/${branch}`;
      await run(["checkout", "-B", branch, remote], { cwd: repoPath, signal });
      await run(["reset", "--hard", remote], { cwd: repoPath, signal });
      await run(["clean", "-fd"], { cwd: repoPath, signal });
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

    async remoteBranches(repoPath, signal): Promise<string[]> {
      return listRemoteBranches(repoPath, signal);
    },

    async revision(path, ref, signal): Promise<string> {
      const result = await run(["rev-parse", "--verify", ref], { cwd: path, signal });
      return result.stdout.trim();
    },

    async currentBranch(path): Promise<string> {
      const result = await run(["branch", "--show-current"], { cwd: path });
      return result.stdout.trim();
    },

    async upstream(path): Promise<{ ref: string | null; gone: boolean }> {
      const branch = (await run(["branch", "--show-current"], { cwd: path })).stdout.trim();
      if (!branch) return { ref: null, gone: false };
      const result = await run(
        ["for-each-ref", "--format=%(upstream:short)%00%(upstream:track)", `refs/heads/${branch}`],
        { cwd: path },
      );
      const [ref = "", tracking = ""] = result.stdout.trim().split("\0", 2);
      return { ref: ref || null, gone: tracking.includes("[gone]") };
    },

    async aheadBehind(path, upstream): Promise<{ ahead: number; behind: number }> {
      const result = await run(["rev-list", "--left-right", "--count", `${upstream}...HEAD`], {
        cwd: path,
      });
      const [behindText, aheadText] = result.stdout.trim().split(/\s+/u);
      const behind = Number(behindText);
      const ahead = Number(aheadText);
      if (
        !Number.isSafeInteger(ahead) ||
        ahead < 0 ||
        !Number.isSafeInteger(behind) ||
        behind < 0
      ) {
        throw gitError(
          ["rev-list", "--left-right", "--count", `${upstream}...HEAD`],
          `unexpected output: ${result.stdout.trim()}`,
        );
      }
      return { ahead, behind };
    },

    async commitCount(path, range): Promise<number> {
      const args = ["rev-list", "--count", range];
      const result = await run(args, { cwd: path });
      const count = Number(result.stdout.trim());
      if (!Number.isSafeInteger(count) || count < 0) {
        throw gitError(args, `unexpected output: ${result.stdout.trim()}`);
      }
      return count;
    },

    async refExists(path, ref): Promise<boolean> {
      const args = ["rev-parse", "--verify", "--quiet", ref];
      const result = await attempt(args, { cwd: path });
      if (result.code === 0) return true;
      if (result.code === 1) return false;
      throw gitError(args, result.stderr);
    },

    async isAncestor(path, ancestor, descendant): Promise<boolean> {
      const args = ["merge-base", "--is-ancestor", ancestor, descendant];
      const result = await attempt(args, { cwd: path });
      if (result.code === 0) return true;
      if (result.code === 1) return false;
      throw gitError(args, result.stderr);
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
