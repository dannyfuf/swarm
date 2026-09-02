import { SwarmError } from "../core/errors.ts";
import type { Clock, StatePort } from "../core/ports.ts";
import type { ContextService, OnEvent, RepoService } from "../core/services.ts";
import { type Context, ContextId, type State } from "../core/types.ts";
import { mutateState } from "./stateMutation.ts";

export interface ContextServiceDependencies {
  state: StatePort;
  clock: Clock;
  repoService: RepoService;
}

function toSwarmError(error: unknown, message: string): SwarmError {
  return error instanceof SwarmError ? error : new SwarmError("fs", message, { cause: error });
}

function forwardProgress(onEvent?: OnEvent): OnEvent | undefined {
  if (!onEvent) return undefined;
  return (event) => {
    if (event.type === "step" || event.type === "log") onEvent(event);
  };
}

function contextId(name: string): ContextId {
  const candidate = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  const parsed = ContextId.safeParse(candidate);
  if (!parsed.success) throw new SwarmError("validation", "Context name must produce a valid id");
  return parsed.data;
}

export function createContextService({
  state,
  clock,
  repoService,
}: ContextServiceDependencies): ContextService {
  const loadState = async (): Promise<State> => {
    try {
      return await state.load();
    } catch (error) {
      throw toSwarmError(error, "Failed to load swarm state");
    }
  };

  const service: ContextService = {
    async list() {
      return (await loadState()).contexts;
    },

    async create(input) {
      const id = contextId(input.name);
      return mutateState(state, (next) => {
        if (next.contexts.some((context) => context.id === id)) {
          throw new SwarmError("conflict", `Context already exists: ${id}`);
        }

        const context: Context = {
          id,
          name: input.name,
          owners: [...input.owners],
          createdAt: clock.now().toISOString(),
        };
        next.contexts.push(context);
        return context;
      });
    },

    async update(id, patch) {
      if (patch.name !== undefined && patch.name.length === 0) {
        throw new SwarmError("validation", "Context name cannot be empty");
      }

      return mutateState(state, (next) => {
        const index = next.contexts.findIndex((context) => context.id === id);
        const current = next.contexts[index];
        if (!current) throw new SwarmError("not-found", `Context not found: ${id}`);

        const updated: Context = {
          ...current,
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.owners === undefined ? {} : { owners: [...patch.owners] }),
        };
        next.contexts[index] = updated;
        return updated;
      });
    },

    async delete(id, onEvent) {
      try {
        await mutateState(state, async (next) => {
          if (!next.contexts.some((context) => context.id === id)) {
            throw new SwarmError("not-found", `Context not found: ${id}`);
          }

          const progress = forwardProgress(onEvent);
          for (const repo of next.repos.filter((candidate) => candidate.contextId === id)) {
            await repoService.delete(repo.id, progress);
          }

          next.contexts = next.contexts.filter((context) => context.id !== id);
          if (next.activeContextId === id) next.activeContextId = next.contexts[0]?.id;
        });
        onEvent?.({ type: "done" });
      } catch (error) {
        const failure = toSwarmError(error, `Failed to delete context: ${id}`);
        onEvent?.({ type: "error", error: failure });
        throw failure;
      }
    },

    async setActive(id: ContextId) {
      await mutateState(state, (next) => {
        if (!next.contexts.some((context) => context.id === id)) {
          throw new SwarmError("not-found", `Context not found: ${id}`);
        }
        next.activeContextId = id;
      });
    },
  };

  return service;
}
