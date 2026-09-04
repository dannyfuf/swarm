import { SwarmError } from "../core/errors.ts";
import type { Clock, FilesPort, GithubPort, GitPort, StatePort } from "../core/ports.ts";
import type { InspectionService, RemoteHostService, StatusService } from "../core/services.ts";
import {
  type Repo,
  type Worktree,
  type WorktreeInspection,
  type WorktreeStatus,
  worktreeHost,
} from "../core/types.ts";

export interface InspectionServiceDependencies {
  state: StatePort;
  files: FilesPort;
  git: GitPort;
  github: GithubPort;
  status: StatusService;
  clock: Clock;
  remoteHosts?: Pick<RemoteHostService, "inspect">;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function baseInspection(
  worktree: Worktree,
  repo: Repo | undefined,
  inspectedAt: string,
  host = worktreeHost(worktree),
): WorktreeInspection {
  return {
    worktreeId: worktree.id,
    repoId: worktree.repoId,
    host,
    path: worktree.path,
    branch: worktree.branch,
    baseRef: worktree.baseRef,
    head: null,
    targetBranch: repo?.defaultBranch ?? "",
    upstream: null,
    ahead: null,
    behind: null,
    upstreamGone: false,
    dirty: false,
    mergedIntoTarget: false,
    uniqueCommits: null,
    published: false,
    merged: false,
    pr: null,
    session: "unknown",
    running: [],
    inspectedAt,
    warnings: [],
    error: null,
  };
}

interface PrunePolicyOptions {
  allowRunning?: boolean;
  requireKnownUniqueCommits?: boolean;
}

function sessionIneligibilityReason(inspection: WorktreeInspection): string | undefined {
  if (inspection.session === "attached") return "tmux session is attached";
  if (inspection.session === "unknown") return "tmux session state is unknown";
  return undefined;
}

export function pruneIneligibilityReason(
  inspection: WorktreeInspection,
  options: PrunePolicyOptions = {},
): string | undefined {
  if (inspection.error) return inspection.error;
  const reasons: string[] = [];
  if (inspection.dirty) reasons.push("worktree has uncommitted changes");
  const sessionReason = sessionIneligibilityReason(inspection);
  if (sessionReason) reasons.push(sessionReason);
  if (!options.allowRunning && inspection.running.length > 0) {
    reasons.push(`tmux session has running commands: ${inspection.running.join(", ")}`);
  }
  const uniqueCommitsUnknown =
    inspection.uniqueCommits === null &&
    (!inspection.merged || options.requireKnownUniqueCommits === true);
  if (uniqueCommitsUnknown) {
    reasons.push("cannot determine unique commits");
  }
  if (!inspection.merged && !uniqueCommitsUnknown) reasons.push("worktree is not merged");
  return reasons.length > 0 ? reasons.join("; ") : undefined;
}

export function createInspectionService({
  state,
  files,
  git,
  github,
  status,
  clock,
  remoteHosts,
}: InspectionServiceDependencies): InspectionService {
  const inspectLocal = async (
    worktrees: Worktree[],
    repos: Map<string, Repo>,
    fetch: boolean,
    inspectedAt: string,
  ): Promise<WorktreeInspection[]> => {
    const fetchWarnings = new Set<string>();
    if (fetch) {
      const repoIds = [...new Set(worktrees.map(({ repoId }) => repoId))];
      await Promise.all(
        repoIds.map(async (repoId) => {
          const repo = repos.get(repoId);
          if (!repo) return;
          try {
            await git.fetch(repo.path, { prune: true });
          } catch {
            fetchWarnings.add(repoId);
          }
        }),
      );
    }

    let statuses = new Map<string, WorktreeStatus>();
    try {
      statuses = await status.snapshot(worktrees);
    } catch {
      // Each inspection retains the explicit unknown status below.
    }

    return Promise.all(
      worktrees.map(async (worktree) => {
        const repo = repos.get(worktree.repoId);
        const inspection = baseInspection(worktree, repo, inspectedAt, "local");
        if (fetchWarnings.has(worktree.repoId)) inspection.warnings.push("fetch failed");
        const worktreeStatus = statuses.get(worktree.id);
        if (worktreeStatus) {
          inspection.session = worktreeStatus.session;
          inspection.running = [...worktreeStatus.running];
        }
        if (!repo) {
          inspection.error = `Repository not found: ${worktree.repoId}`;
          return inspection;
        }

        try {
          if (!(await files.exists(worktree.path))) {
            inspection.error = `Worktree directory is missing: ${worktree.path}`;
            return inspection;
          }
        } catch (error) {
          inspection.error = `Unable to inspect worktree directory: ${messageOf(error)}`;
          return inspection;
        }

        try {
          const pr = await github.findLatestPullRequest(repo, worktree.branch);
          if (pr) {
            inspection.pr = pr;
            inspection.targetBranch = pr.baseRefName;
          }
        } catch {
          inspection.warnings.push("gh unavailable");
        }

        try {
          const [head, upstream, dirty] = await Promise.all([
            git.revision(worktree.path, "HEAD"),
            git.upstream(worktree.path),
            git.isDirty(worktree.path),
          ]);
          inspection.head = head;
          inspection.upstream = upstream.ref;
          inspection.upstreamGone = upstream.gone;
          inspection.published = upstream.gone && upstream.ref === `origin/${worktree.branch}`;
          inspection.dirty = dirty;
          if (!upstream.ref) {
            inspection.warnings.push("no upstream");
          } else if (upstream.gone) {
            inspection.warnings.push("upstream gone");
          } else {
            try {
              const divergence = await git.aheadBehind(worktree.path, upstream.ref);
              inspection.ahead = divergence.ahead;
              inspection.behind = divergence.behind;
            } catch {
              inspection.warnings.push("ahead/behind unavailable");
            }
          }
        } catch (error) {
          inspection.error = `Unable to inspect Git state: ${messageOf(error)}`;
          return inspection;
        }

        try {
          if (await git.refExists(worktree.path, `refs/remotes/origin/${worktree.branch}`)) {
            inspection.published = true;
          }
        } catch {
          inspection.warnings.push("published status unavailable");
        }

        const targetRef = `origin/${inspection.targetBranch}`;
        let targetExists: boolean | undefined;
        try {
          targetExists = await git.refExists(
            worktree.path,
            `refs/remotes/origin/${inspection.targetBranch}`,
          );
        } catch {
          inspection.warnings.push("target ref unavailable");
        }
        if (targetExists === false) {
          inspection.warnings.push("target ref missing");
        } else if (targetExists) {
          try {
            inspection.uniqueCommits = await git.commitCount(worktree.path, `${targetRef}..HEAD`);
          } catch {
            inspection.warnings.push("unique commit count unavailable");
          }
          try {
            inspection.mergedIntoTarget = await git.isAncestor(worktree.path, "HEAD", targetRef);
          } catch {
            inspection.warnings.push("target comparison failed");
          }
        }
        let mergedPullRequest = false;
        if (inspection.pr?.state === "MERGED" && inspection.head !== null) {
          if (inspection.head === inspection.pr.headRefOid) {
            mergedPullRequest = true;
          } else {
            try {
              mergedPullRequest = await git.isAncestor(
                worktree.path,
                inspection.head,
                inspection.pr.headRefOid,
              );
            } catch {
              inspection.warnings.push("pull request head comparison failed");
            }
          }
        }
        inspection.merged =
          mergedPullRequest || (inspection.mergedIntoTarget && inspection.published);
        return inspection;
      }),
    );
  };

  return {
    async inspect(input = {}) {
      const current = await state.load();
      const requested = input.worktreeIds
        ? input.worktreeIds.map((id) => {
            const worktree = current.worktrees.find((candidate) => candidate.id === id);
            if (!worktree) throw new SwarmError("not-found", `Worktree not found: ${id}`);
            return worktree;
          })
        : current.worktrees;
      const selected = requested.filter(
        (worktree) => input.repoId === undefined || worktree.repoId === input.repoId,
      );
      const repos = new Map(current.repos.map((repo) => [repo.id, repo]));
      const inspectedAt = clock.now().toISOString();
      const local = selected.filter((worktree) => worktreeHost(worktree) === "local");
      const localPromise = inspectLocal(local, repos, input.fetch ?? false, inspectedAt);
      const remoteByHost = new Map<string, Worktree[]>();
      for (const worktree of selected) {
        const host = worktreeHost(worktree);
        if (host === "local") continue;
        const entries = remoteByHost.get(host) ?? [];
        entries.push(worktree);
        remoteByHost.set(host, entries);
      }

      const remotePromises = [...remoteByHost].map(async ([hostId, worktrees]) => {
        if (!remoteHosts) {
          return worktrees.map((worktree) => {
            const inspection = baseInspection(worktree, repos.get(worktree.repoId), inspectedAt);
            inspection.error = `Remote host service is unavailable: ${hostId}`;
            return inspection;
          });
        }
        try {
          const remote = await remoteHosts.inspect(
            hostId,
            worktrees.map(({ id }) => id),
            { fetch: input.fetch },
          );
          const byId = new Map(remote.map((inspection) => [inspection.worktreeId, inspection]));
          return worktrees.map((worktree) => {
            const inspection = byId.get(worktree.id);
            if (inspection) return { ...inspection, host: hostId };
            const omitted = baseInspection(worktree, repos.get(worktree.repoId), inspectedAt);
            omitted.error = `${hostId}: remote inspection omitted ${worktree.id}`;
            return omitted;
          });
        } catch (error) {
          return worktrees.map((worktree) => {
            const inspection = baseInspection(worktree, repos.get(worktree.repoId), inspectedAt);
            inspection.error = messageOf(error);
            return inspection;
          });
        }
      });

      const combined = [...(await localPromise), ...(await Promise.all(remotePromises)).flat()];
      const byId = new Map(combined.map((inspection) => [inspection.worktreeId, inspection]));
      return selected.flatMap((worktree) => {
        const inspection = byId.get(worktree.id);
        return inspection ? [inspection] : [];
      });
    },
  };
}
