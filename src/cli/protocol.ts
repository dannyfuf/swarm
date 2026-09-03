import { setTimeout as wait } from "node:timers/promises";
import { SwarmError } from "../core/errors.ts";
import { isWorktreeSlug } from "../core/paths.ts";
import type { StatePort } from "../core/ports.ts";
import { PROTOCOL_VERSION } from "../core/protocol.ts";
import { validateBranch } from "../core/prs.ts";
import type {
  ContextService,
  RepoService,
  SessionService,
  StatusService,
  WorktreeService,
} from "../core/services.ts";
import {
  type Repo,
  type RepoHooks,
  type RepoId,
  type Worktree,
  type WorktreeId,
  WorktreeId as WorktreeIdSchema,
  type WorktreeStatus,
  worktreeHost,
} from "../core/types.ts";
import { VERSION } from "../core/version.ts";
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
      branch: string;
      baseRef: string;
      url?: string;
      defaultBranch?: string;
      hooks: RepoHooks;
    } & JsonOption)
  | ({ kind: "delete"; worktreeId: WorktreeId } & JsonOption)
  | ({ kind: "kill"; worktreeId: WorktreeId } & JsonOption)
  | ({ kind: "status" } & JsonOption);

export type ProtocolResponse =
  | {
      protocol: typeof PROTOCOL_VERSION;
      version: string;
      repos: Repo[];
      worktrees: Worktree[];
    }
  | { protocol: typeof PROTOCOL_VERSION; worktree: Worktree }
  | { protocol: typeof PROTOCOL_VERSION; ok: true }
  | {
      protocol: typeof PROTOCOL_VERSION;
      statuses: WorktreeStatus[];
    };

export interface ProtocolDependencies {
  state: StatePort;
  contexts: ContextService;
  repos: RepoService;
  worktrees: WorktreeService;
  sessions: SessionService;
  status: StatusService;
  waitForClonePoll?: (milliseconds: number) => Promise<void>;
}

export interface ProtocolErrorEnvelope {
  protocol: typeof PROTOCOL_VERSION;
  error: { kind: string; message: string };
}

export function isProtocolCommand(command: { kind: string }): command is ProtocolCommand {
  return ["list", "create", "delete", "kill", "status"].includes(command.kind);
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
): Promise<Worktree> {
  validateBranch(command.branch);
  if (!isWorktreeSlug(command.slug)) {
    throw new SwarmError("validation", `Invalid worktree slug: ${command.slug}`);
  }
  const state = await deps.state.load();
  const repo =
    state.repos.find((candidate) => candidate.id === command.repoId) ??
    (await registerRepo(command, deps));
  const created = await deps.worktrees.create({
    repoId: repo.id,
    slug: command.slug,
    branch: command.branch,
    baseRef: command.baseRef,
  });
  await deps.worktrees.runPostCreateHooks(created.id);
  return created;
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
      repos: state.repos,
      worktrees: state.worktrees,
    };
  }

  if (command.kind === "create") {
    return { protocol: PROTOCOL_VERSION, worktree: await createWorktree(command, deps) };
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
  if (command.kind === "delete") await deps.worktrees.delete(worktree.id);
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
    return `Created ${response.worktree.id}`;
  }
  if (command.kind === "delete") return `Deleted ${command.worktreeId}`;
  if (command.kind === "kill") return `Killed ${command.worktreeId}`;
  if (command.kind === "status" && "statuses" in response) {
    return response.statuses.map((status) => `${status.worktreeId} ${status.session}`).join("\n");
  }
  throw new SwarmError("unsupported", `Unsupported protocol command: ${command.kind}`);
}
