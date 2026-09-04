import { z } from "zod";
import { type ErrorCode, SwarmError } from "../core/errors.ts";
import { worktreeId as makeWorktreeId } from "../core/paths.ts";
import type { ConfigPort, Logger, RemoteHostPort, ShellResult, StatePort } from "../core/ports.ts";
import { PROTOCOL_VERSION } from "../core/protocol.ts";
import type { RemoteHostService, UnmountReport } from "../core/services.ts";
import {
  type HostId,
  RepoSchema,
  type Worktree,
  WorktreeId,
  WorktreeInspectionSchema,
  WorktreeSchema,
  worktreeHost,
} from "../core/types.ts";
import { mutateState } from "./stateMutation.ts";

const StatusSchema = z.object({
  worktreeId: WorktreeId,
  session: z.enum(["none", "detached", "attached", "unknown"]),
  windows: z.array(
    z.object({
      index: z.number().int(),
      name: z.string(),
      command: z.string(),
      keepAlive: z.array(z.string()),
    }),
  ),
  running: z.array(z.string()),
});

const ListEnvelopeSchema = z.object({
  protocol: z.number().int(),
  version: z.string(),
  repos: z.array(RepoSchema),
  worktrees: z.array(WorktreeSchema),
});
const WorktreeEnvelopeSchema = z.object({
  protocol: z.number().int(),
  created: z.boolean().default(true),
  worktree: WorktreeSchema,
});
const OkEnvelopeSchema = z.object({ protocol: z.number().int(), ok: z.literal(true) });
const DeleteEnvelopeSchema = z.object({
  protocol: z.number().int(),
  ok: z.boolean(),
  results: z
    .array(z.object({ worktreeId: WorktreeId, ok: z.boolean(), reason: z.string().optional() }))
    .default([]),
});
const InspectEnvelopeSchema = z.object({
  protocol: z.number().int(),
  worktrees: z.array(WorktreeInspectionSchema),
});
const StatusEnvelopeSchema = z.object({
  protocol: z.number().int(),
  statuses: z.array(StatusSchema),
});
const SleepEnvelopeSchema = z.object({
  protocol: z.number().int(),
  kept: z.array(z.object({ window: z.string(), reason: z.string() })),
  closed: z.array(z.string()),
  sessionKilled: z.boolean(),
});
const ErrorEnvelopeSchema = z.object({
  protocol: z.number().int(),
  error: z.object({ kind: z.string(), message: z.string() }),
});

const errorCodes = new Set<ErrorCode>([
  "not-found",
  "conflict",
  "refused",
  "git",
  "tmux",
  "fs",
  "github",
  "remote",
  "validation",
  "cancelled",
  "unsupported",
]);
const SHORT_COMMAND_TIMEOUT_MS = 30_000;

export interface RemoteHostServiceDependencies {
  transport: RemoteHostPort;
  config: ConfigPort;
  state: StatePort;
  logger: Logger;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJson(hostId: HostId, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new SwarmError("remote", `${hostId}: invalid JSON response from remote swarm`, { cause });
  }
}

function assertProtocol(hostId: HostId, value: unknown): void {
  const protocol =
    typeof value === "object" && value !== null && "protocol" in value
      ? (value as { protocol?: unknown }).protocol
      : undefined;
  if (protocol !== PROTOCOL_VERSION) {
    throw new SwarmError(
      "remote",
      `${hostId}: protocol mismatch (local ${PROTOCOL_VERSION}, remote ${String(protocol ?? "missing")})`,
    );
  }
}

function envelopeError(hostId: HostId, value: unknown): SwarmError | undefined {
  const parsed = ErrorEnvelopeSchema.safeParse(value);
  if (!parsed.success) return undefined;
  assertProtocol(hostId, parsed.data);
  const code = errorCodes.has(parsed.data.error.kind as ErrorCode)
    ? (parsed.data.error.kind as ErrorCode)
    : "remote";
  return new SwarmError(code, `${hostId}: ${parsed.data.error.message}`);
}

function unreachable(hostId: HostId, detail: string, cause?: unknown): SwarmError {
  return new SwarmError("remote", `${hostId} unreachable: ${detail || "ssh failed"}`, { cause });
}

export function createRemoteHostService({
  transport,
  config,
  state,
  logger,
}: RemoteHostServiceDependencies): RemoteHostService {
  const snapshotErrors = new Map<HostId, SwarmError>();

  const resolveHost = async (hostId: HostId) => {
    const loaded = await config.load();
    const host = loaded.hosts[hostId];
    if (!host) throw new SwarmError("not-found", `Remote host not found: ${hostId}`);
    return { id: hostId, ...host };
  };

  const invoke = async <T>(
    hostId: HostId,
    args: string[],
    schema: z.ZodType<T>,
    opts?: { timeoutMs?: number; allowNonzero?: boolean },
  ): Promise<T> => {
    const host = await resolveHost(hostId);
    let result: ShellResult;
    try {
      result = await transport.run(host, args, { timeoutMs: opts?.timeoutMs });
    } catch (cause) {
      throw unreachable(hostId, errorMessage(cause), cause);
    }

    if (result.code === 255 || result.code === 124) {
      throw unreachable(
        hostId,
        result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`,
      );
    }

    const value = result.stdout.trim().length > 0 ? parseJson(hostId, result.stdout) : undefined;
    if (result.code !== 0) {
      const remoteError = envelopeError(hostId, value);
      if (remoteError) throw remoteError;
      if (!opts?.allowNonzero || value === undefined) {
        throw new SwarmError(
          "remote",
          `${hostId}: ${result.stderr.trim() || result.stdout.trim() || `remote swarm exited ${result.code}`}`,
        );
      }
    }

    assertProtocol(hostId, value);
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new SwarmError("remote", `${hostId}: invalid remote swarm response`, {
        cause: parsed.error,
      });
    }
    return parsed.data;
  };

  const service: RemoteHostService = {
    list(hostId) {
      return invoke(hostId, ["list", "--json"], ListEnvelopeSchema, {
        timeoutMs: SHORT_COMMAND_TIMEOUT_MS,
      });
    },

    async create(hostId, { repo, slug, branch, baseRef }) {
      const id = makeWorktreeId(repo.id, slug);
      const current = await state.load();
      const existing = current.worktrees.find((worktree) => worktree.id === id);
      if (existing) {
        if (
          (branch === undefined || existing.branch === branch) &&
          worktreeHost(existing) === hostId
        ) {
          return { created: false, worktree: existing };
        }
        throw new SwarmError("conflict", `Worktree already exists with different placement: ${id}`);
      }
      const response = await invoke(
        hostId,
        [
          "create",
          repo.id,
          slug,
          ...(branch ? ["--branch", branch] : []),
          "--base",
          baseRef,
          "--url",
          repo.url,
          "--default-branch",
          repo.defaultBranch,
          "--hooks",
          JSON.stringify(repo.hooks),
          "--json",
        ],
        WorktreeEnvelopeSchema,
      );
      return { created: response.created, worktree: response.worktree };
    },

    async delete(hostId, worktreeId, opts) {
      const response = await invoke(
        hostId,
        ["delete", worktreeId, ...(opts?.force ? ["--force"] : []), "--json"],
        DeleteEnvelopeSchema,
        { timeoutMs: SHORT_COMMAND_TIMEOUT_MS, allowNonzero: true },
      );
      const result = response.results.find((candidate) => candidate.worktreeId === worktreeId);
      return result
        ? { ok: result.ok, ...(result.reason ? { reason: result.reason } : {}) }
        : {
            ok: response.ok,
            ...(response.ok ? {} : { reason: "remote delete omitted its result" }),
          };
    },

    async kill(hostId, worktreeId) {
      await invoke(hostId, ["kill", worktreeId, "--json"], OkEnvelopeSchema, {
        timeoutMs: SHORT_COMMAND_TIMEOUT_MS,
      });
    },

    async sleep(hostId, session) {
      const response = await invoke(hostId, ["sleep", session, "--json"], SleepEnvelopeSchema, {
        timeoutMs: SHORT_COMMAND_TIMEOUT_MS,
      });
      return {
        kept: response.kept,
        closed: response.closed,
        sessionKilled: response.sessionKilled,
      } satisfies UnmountReport;
    },

    async status(hostId) {
      const response = await invoke(hostId, ["status", "--json"], StatusEnvelopeSchema, {
        timeoutMs: SHORT_COMMAND_TIMEOUT_MS,
      });
      return response.statuses;
    },

    async inspect(hostId, worktreeIds, opts) {
      const response = await invoke(
        hostId,
        ["inspect", ...worktreeIds, ...(opts?.fetch ? ["--fetch"] : []), "--json"],
        InspectEnvelopeSchema,
        { timeoutMs: SHORT_COMMAND_TIMEOUT_MS },
      );
      return response.worktrees;
    },

    async sync(hostId) {
      const remote = await service.list(hostId);
      return mutateState(state, (next) => {
        const repoIds = new Set(next.repos.map((repo) => repo.id));
        const previous = new Map(
          next.worktrees
            .filter((worktree) => worktree.host === hostId)
            .map((worktree) => [worktree.id, worktree]),
        );
        const mirrored: Worktree[] = [];
        for (const worktree of remote.worktrees) {
          const collision = next.worktrees.find(
            (candidate) => candidate.id === worktree.id && worktreeHost(candidate) !== hostId,
          );
          if (collision) {
            logger.warn(
              `Skipping ${hostId} worktree ${worktree.id}: id already belongs to host ${worktreeHost(collision)}`,
            );
            continue;
          }
          if (!repoIds.has(worktree.repoId)) {
            logger.warn(`Skipping ${hostId} worktree with unregistered repo: ${worktree.id}`);
            continue;
          }
          const existing = previous.get(worktree.id);
          mirrored.push({
            ...worktree,
            host: hostId,
            ...(existing?.lastOpenedAt ? { lastOpenedAt: existing.lastOpenedAt } : {}),
          });
        }
        next.worktrees = [
          ...next.worktrees.filter((worktree) => worktree.host !== hostId),
          ...mirrored,
        ];
        return structuredClone(mirrored);
      });
    },

    async syncAll() {
      const loaded = await config.load();
      return Promise.all(
        Object.keys(loaded.hosts).map(async (hostId) => {
          try {
            await service.sync(hostId);
            return { hostId };
          } catch (error) {
            return {
              hostId,
              error:
                error instanceof SwarmError
                  ? error
                  : unreachable(hostId, errorMessage(error), error),
            };
          }
        }),
      );
    },

    async remoteSnapshot(hostId) {
      const current = await state.load();
      const mirrored = current.worktrees.filter((worktree) => worktree.host === hostId);
      try {
        const allowed = new Set(mirrored.map((worktree) => worktree.id));
        const statuses = await service.status(hostId);
        snapshotErrors.delete(hostId);
        return new Map(
          statuses
            .filter((status) => allowed.has(status.worktreeId))
            .map((status) => [status.worktreeId, status]),
        );
      } catch (error) {
        const failure =
          error instanceof SwarmError ? error : unreachable(hostId, errorMessage(error), error);
        snapshotErrors.set(hostId, failure);
        return new Map(
          mirrored.map((worktree) => [
            worktree.id,
            { worktreeId: worktree.id, session: "unknown", windows: [], running: [] },
          ]),
        );
      }
    },

    lastError(hostId) {
      return snapshotErrors.get(hostId);
    },
  };

  return service;
}
