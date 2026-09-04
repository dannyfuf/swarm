import { resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { SwarmError } from "../core/errors.ts";
import { isWorktreeSlug, worktreeId as makeWorktreeId } from "../core/paths.ts";
import type { StatePort } from "../core/ports.ts";
import { PROTOCOL_VERSION } from "../core/protocol.ts";
import { validateBranch } from "../core/prs.ts";
import type {
  ContextService,
  InspectionService,
  RemoteHostService,
  RepoService,
  SessionService,
  StatusService,
  WorktreeService,
} from "../core/services.ts";
import {
  type HostId,
  type Repo,
  type RepoHooks,
  type RepoId,
  type Worktree,
  type WorktreeId,
  WorktreeId as WorktreeIdSchema,
  type WorktreeInspection,
  type WorktreeStatus,
  worktreeHost,
} from "../core/types.ts";
import { VERSION } from "../core/version.ts";
import { deleteRefusalReason, pruneIneligibilityReason } from "../services/inspections.ts";
import { mutateState } from "../services/stateMutation.ts";

export { PROTOCOL_VERSION } from "../core/protocol.ts";

export const CLI_VERSION = `swarm ${VERSION}`;

interface JsonOption {
  json: boolean;
}

export type ProtocolCommand =
  | ({ kind: "list" } & JsonOption)
  | ({
      kind: "create";
      repoId: RepoId;
      slug: string;
      branch?: string;
      baseRef?: string;
      host?: HostId;
      url?: string;
      defaultBranch?: string;
      hooks: RepoHooks;
    } & JsonOption)
  | ({ kind: "delete"; worktreeIds: WorktreeId[]; force: boolean } & JsonOption)
  | ({ kind: "kill"; worktreeId: WorktreeId } & JsonOption)
  | ({ kind: "status" } & JsonOption)
  | ({
      kind: "inspect";
      worktreeIds: WorktreeId[];
      fetch: boolean;
      repoId?: RepoId;
    } & JsonOption)
  | ({
      kind: "prune";
      dryRun: boolean;
      noFetch: boolean;
      killSessions: boolean;
      repoId?: RepoId;
    } & JsonOption);

export interface DeleteResult {
  worktreeId: WorktreeId;
  ok: boolean;
  reason?: string;
}

export interface PruneSkipped {
  worktreeId: WorktreeId;
  reason: string;
  merged: boolean;
  dirty: boolean;
  uniqueCommits: number | null;
  running: string[];
}

export type ProtocolResponse =
  | {
      protocol: typeof PROTOCOL_VERSION;
      version: string;
      repos: Repo[];
      worktrees: Worktree[];
    }
  | { protocol: typeof PROTOCOL_VERSION; created: boolean; worktree: Worktree }
  | { protocol: typeof PROTOCOL_VERSION; ok: true }
  | {
      protocol: typeof PROTOCOL_VERSION;
      statuses: WorktreeStatus[];
    }
  | { protocol: typeof PROTOCOL_VERSION; worktrees: WorktreeInspection[] }
  | { protocol: typeof PROTOCOL_VERSION; ok: boolean; results: DeleteResult[] }
  | {
      protocol: typeof PROTOCOL_VERSION;
      dryRun: boolean;
      deleted: WorktreeId[];
      skipped: PruneSkipped[];
    };

export interface ProtocolDependencies {
  state: StatePort;
  contexts: ContextService;
  repos: RepoService;
  worktrees: WorktreeService;
  sessions: SessionService;
  status: StatusService;
  inspections: InspectionService;
  remoteHosts?: RemoteHostService;
  waitForClonePoll?: (milliseconds: number) => Promise<void>;
}

export interface ProtocolErrorEnvelope {
  protocol: typeof PROTOCOL_VERSION;
  error: { kind: string; message: string };
}

export function isProtocolCommand(command: { kind: string }): command is ProtocolCommand {
  return ["list", "create", "delete", "kill", "status", "inspect", "prune"].includes(command.kind);
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").trim() || "Unknown error";
}

export function protocolErrorEnvelope(error: unknown): ProtocolErrorEnvelope {
  return {
    protocol: PROTOCOL_VERSION,
    error: {
      kind: error instanceof SwarmError ? error.code : "unknown",
      message: messageOf(error),
    },
  };
}

function requireWorktree(worktrees: Worktree[], id: WorktreeId): Worktree {
  const worktree = worktrees.find((candidate) => candidate.id === id);
  if (!worktree) throw new SwarmError("not-found", `Worktree not found: ${id}`);
  return worktree;
}

async function cloneContextId(owner: string, deps: ProtocolDependencies): Promise<string> {
  const state = await deps.state.load();
  const matching = state.contexts.find((context) => context.owners.includes(owner));
  const context =
    matching ??
    state.contexts.find((candidate) => candidate.id === state.activeContextId) ??
    state.contexts[0];
  if (context) return context.id;
  return (await deps.contexts.create({ name: owner, owners: [owner] })).id;
}

async function awaitClonedRepo(repoId: RepoId, deps: ProtocolDependencies): Promise<Repo> {
  const poll = deps.waitForClonePoll ?? ((milliseconds: number) => wait(milliseconds));
  while (true) {
    await deps.repos.reconcileClones();
    const state = await deps.state.load();
    const repo = state.repos.find((candidate) => candidate.id === repoId);
    if (repo) return repo;
    const job = state.clones.find((candidate) => candidate.id === repoId);
    if (!job) throw new SwarmError("git", `Clone did not register repository: ${repoId}`);
    if (job.status === "failed") {
      throw new SwarmError("git", job.error ?? `Failed to clone repository: ${repoId}`);
    }
    await poll(100);
  }
}

async function registerRepo(
  command: Extract<ProtocolCommand, { kind: "create" }>,
  deps: ProtocolDependencies,
): Promise<Repo> {
  const persistHooks = (): Promise<Repo> =>
    mutateState(deps.state, (state) => {
      const repo = state.repos.find((candidate) => candidate.id === command.repoId);
      if (!repo) throw new SwarmError("not-found", `Repository not found: ${command.repoId}`);
      repo.hooks = structuredClone(command.hooks);
      return structuredClone(repo);
    });

  await deps.repos.reconcileClones();
  const reconciled = await deps.state.load();
  const existing = reconciled.repos.find((candidate) => candidate.id === command.repoId);
  if (existing) return persistHooks();
  const clone = reconciled.clones.find((candidate) => candidate.id === command.repoId);
  if (clone?.status === "failed") {
    throw new SwarmError("git", clone.error ?? `Failed to clone repository: ${command.repoId}`);
  }
  if (clone) {
    await awaitClonedRepo(command.repoId, deps);
    return persistHooks();
  }
  if (!command.url) {
    throw new SwarmError(
      "validation",
      `Repository ${command.repoId} is not registered; --url is required`,
    );
  }
  const [owner, name] = command.repoId.split("/") as [string, string];
  const contextId = await cloneContextId(owner, deps);
  await deps.repos.clone(
    {
      owner,
      name,
      fullName: command.repoId,
      description: "",
      sshUrl: command.url,
      isPrivate: false,
      updatedAt: new Date(0).toISOString(),
      defaultBranch: command.defaultBranch ?? "",
    },
    contextId,
    undefined,
    { url: command.url },
  );
  await awaitClonedRepo(command.repoId, deps);
  return persistHooks();
}

async function createWorktree(
  command: Extract<ProtocolCommand, { kind: "create" }>,
  deps: ProtocolDependencies,
): Promise<{ created: boolean; worktree: Worktree }> {
  const branch = command.branch ?? command.slug;
  validateBranch(branch);
  if (!isWorktreeSlug(command.slug)) {
    throw new SwarmError("validation", `Invalid worktree slug: ${command.slug}`);
  }
  const id = makeWorktreeId(command.repoId, command.slug);
  const state = await deps.state.load();
  const existing = state.worktrees.find((candidate) => candidate.id === id);
  if (existing) {
    const branchMatches = command.branch === undefined || existing.branch === command.branch;
    const hostMatches = command.host === undefined || worktreeHost(existing) === command.host;
    if (branchMatches && hostMatches) {
      return { created: false, worktree: existing };
    }
    throw new SwarmError(
      "conflict",
      `Worktree ${id} already exists with branch ${existing.branch} on ${worktreeHost(existing)}`,
    );
  }
  const repo =
    state.repos.find((candidate) => candidate.id === command.repoId) ??
    (await registerRepo(command, deps));
  const baseRef = command.baseRef ?? `origin/${repo.defaultBranch}`;
  if (command.host) {
    if (!deps.remoteHosts) {
      throw new SwarmError("unsupported", "Remote host service is unavailable");
    }
    const response = await deps.remoteHosts.create(command.host, {
      repo,
      slug: command.slug,
      ...(command.branch ? { branch: command.branch } : {}),
      baseRef,
    });
    const synced = await deps.remoteHosts.sync(command.host);
    return {
      created: response.created,
      worktree: synced.find((worktree) => worktree.id === response.worktree.id) ?? {
        ...response.worktree,
        host: command.host,
      },
    };
  }
  const created = await deps.worktrees.create({
    repoId: repo.id,
    slug: command.slug,
    branch,
    baseRef,
  });
  await deps.worktrees.runPostCreateHooks(created.id);
  return { created: true, worktree: created };
}

async function deleteOne(
  worktreeId: WorktreeId,
  force: boolean,
  deps: ProtocolDependencies,
  pruneOptions?: { killSessions: boolean },
): Promise<{ result: DeleteResult; inspection?: WorktreeInspection }> {
  const refusalReason = (inspection: WorktreeInspection): string | undefined =>
    pruneOptions
      ? pruneIneligibilityReason(inspection, {
          allowRunning: pruneOptions.killSessions,
          requireKnownUniqueCommits: pruneOptions.killSessions,
        })
      : deleteRefusalReason(inspection);
  let latest: WorktreeInspection | undefined;
  try {
    const [initial] = await deps.inspections.inspect({ worktreeIds: [worktreeId] });
    if (!initial) throw new SwarmError("not-found", `Worktree not found: ${worktreeId}`);
    latest = initial;
    if (!force) {
      const reason = refusalReason(initial);
      if (reason) return { result: { worktreeId, ok: false, reason }, inspection: initial };
    }

    const [rechecked] = await deps.inspections.inspect({ worktreeIds: [worktreeId] });
    if (!rechecked) throw new SwarmError("not-found", `Worktree not found: ${worktreeId}`);
    latest = rechecked;
    if (!force) {
      const reason = refusalReason(rechecked);
      if (reason) return { result: { worktreeId, ok: false, reason }, inspection: rechecked };
    }
    await deps.worktrees.delete(worktreeId, undefined, {
      force: force || pruneOptions?.killSessions === true,
    });
    return { result: { worktreeId, ok: true }, inspection: latest };
  } catch (error) {
    return {
      result: { worktreeId, ok: false, reason: messageOf(error) },
      ...(latest ? { inspection: latest } : {}),
    };
  }
}

function pruneSkipped(inspection: WorktreeInspection, reason: string): PruneSkipped {
  return {
    worktreeId: inspection.worktreeId,
    reason,
    merged: inspection.merged,
    dirty: inspection.dirty,
    uniqueCommits: inspection.uniqueCommits,
    running: [...inspection.running],
  };
}

export async function handleProtocolCommand(
  command: ProtocolCommand,
  deps: ProtocolDependencies,
): Promise<ProtocolResponse> {
  if (command.kind === "list") {
    const state = await deps.state.load();
    return {
      protocol: PROTOCOL_VERSION,
      version: CLI_VERSION,
      repos: state.repos.map((repo) => ({ ...repo, path: resolve(repo.path) })),
      worktrees: state.worktrees.map((worktree) => ({
        ...worktree,
        path: worktreeHost(worktree) === "local" ? resolve(worktree.path) : worktree.path,
      })),
    };
  }

  if (command.kind === "create") {
    return { protocol: PROTOCOL_VERSION, ...(await createWorktree(command, deps)) };
  }

  if (command.kind === "inspect") {
    return {
      protocol: PROTOCOL_VERSION,
      worktrees: await deps.inspections.inspect({
        ...(command.worktreeIds.length > 0 ? { worktreeIds: command.worktreeIds } : {}),
        ...(command.repoId ? { repoId: command.repoId } : {}),
        fetch: command.fetch,
      }),
    };
  }

  if (command.kind === "delete") {
    const results: DeleteResult[] = [];
    for (const worktreeId of command.worktreeIds) {
      results.push((await deleteOne(worktreeId, command.force, deps)).result);
    }
    return {
      protocol: PROTOCOL_VERSION,
      ok: results.every(({ ok }) => ok),
      results,
    };
  }

  if (command.kind === "prune") {
    const inspections = await deps.inspections.inspect({
      ...(command.repoId ? { repoId: command.repoId } : {}),
      fetch: !command.noFetch,
    });
    const deleted: WorktreeId[] = [];
    const skipped: PruneSkipped[] = [];
    const eligible: WorktreeId[] = [];
    const byId = new Map(inspections.map((inspection) => [inspection.worktreeId, inspection]));
    for (const inspection of inspections) {
      const reason = pruneIneligibilityReason(inspection, {
        allowRunning: command.killSessions,
        requireKnownUniqueCommits: command.killSessions,
      });
      if (reason) skipped.push(pruneSkipped(inspection, reason));
      else eligible.push(inspection.worktreeId);
    }
    if (command.dryRun) {
      deleted.push(...eligible);
    } else {
      for (const worktreeId of eligible) {
        const attempt = await deleteOne(worktreeId, false, deps, {
          killSessions: command.killSessions,
        });
        const { result } = attempt;
        if (result.ok) deleted.push(worktreeId);
        else {
          const inspection = attempt.inspection ?? byId.get(worktreeId);
          if (!inspection) throw new SwarmError("not-found", `Worktree not found: ${worktreeId}`);
          skipped.push(pruneSkipped(inspection, result.reason ?? "delete failed"));
        }
      }
    }
    return { protocol: PROTOCOL_VERSION, dryRun: command.dryRun, deleted, skipped };
  }

  const state = await deps.state.load();
  if (command.kind === "status") {
    const localWorktrees = state.worktrees.filter((worktree) => worktreeHost(worktree) === "local");
    const statuses = await deps.status.snapshot(localWorktrees);
    return {
      protocol: PROTOCOL_VERSION,
      statuses: localWorktrees.map((worktree) => {
        const status = statuses.get(worktree.id);
        if (!status) {
          throw new SwarmError("tmux", `Status snapshot omitted worktree: ${worktree.id}`);
        }
        return status;
      }),
    };
  }

  const parsedId = WorktreeIdSchema.safeParse(command.worktreeId);
  if (!parsedId.success) {
    throw new SwarmError("validation", `Invalid worktree id: ${command.worktreeId}`);
  }
  const id = parsedId.data;
  const worktree = requireWorktree(state.worktrees, id);
  await deps.sessions.kill(worktree);
  return { protocol: PROTOCOL_VERSION, ok: true };
}

export function humanProtocolResponse(
  command: ProtocolCommand,
  response: ProtocolResponse,
): string {
  if (command.kind === "list" && "repos" in response) {
    return `${response.repos.length} repos, ${response.worktrees.length} worktrees`;
  }
  if (command.kind === "create" && "worktree" in response) {
    return `${response.created ? "Created" : "Existing"} ${response.worktree.id}`;
  }
  if (command.kind === "delete" && "results" in response) {
    return response.results
      .map((result) =>
        result.ok
          ? `Deleted ${result.worktreeId}`
          : `Skipped ${result.worktreeId}: ${result.reason}`,
      )
      .join("\n");
  }
  if (command.kind === "kill") return `Killed ${command.worktreeId}`;
  if (command.kind === "status" && "statuses" in response) {
    return response.statuses.map((status) => `${status.worktreeId} ${status.session}`).join("\n");
  }
  if (command.kind === "inspect" && "worktrees" in response && !("repos" in response)) {
    return response.worktrees
      .map((inspection) =>
        inspection.error
          ? `${inspection.worktreeId} error: ${inspection.error}`
          : `${inspection.worktreeId} ${inspection.dirty ? "dirty" : "clean"} ${inspection.session}`,
      )
      .join("\n");
  }
  if (command.kind === "prune" && "deleted" in response) {
    const verb = response.dryRun ? "Would delete" : "Deleted";
    return [
      ...response.deleted.map((worktreeId) => `${verb} ${worktreeId}`),
      ...response.skipped.map(({ worktreeId, reason }) => `Skipped ${worktreeId}: ${reason}`),
    ].join("\n");
  }
  throw new SwarmError("unsupported", `Unsupported protocol command: ${command.kind}`);
}
