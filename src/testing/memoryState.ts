import { AsyncLocalStorage } from "node:async_hooks";
import type { StatePort } from "../core/ports.ts";
import { defaultState, type State } from "../core/types.ts";

export type MemoryState = StatePort & {
  readonly state: State;
  readonly saves: State[];
  mutate<T>(mutation: (state: State) => Promise<T> | T): Promise<T>;
};

export function createMemoryState(initial: State = defaultState()): MemoryState {
  let current = structuredClone(initial);
  const saves: State[] = [];
  let mutationChain: Promise<void> = Promise.resolve();
  const transaction = new AsyncLocalStorage<State>();
  return {
    get state() {
      return current;
    },
    saves,
    async load() {
      return structuredClone(transaction.getStore() ?? current);
    },
    async save(state) {
      const active = transaction.getStore();
      if (active) {
        active.contexts = structuredClone(state.contexts);
        active.repos = structuredClone(state.repos);
        active.clones = structuredClone(state.clones);
        active.worktrees = structuredClone(state.worktrees);
        active.activeContextId = state.activeContextId;
        return;
      }
      current = structuredClone(state);
      saves.push(structuredClone(state));
    },
    async mutate(mutation) {
      const active = transaction.getStore();
      if (active) {
        const value = await mutation(active);
        current = structuredClone(active);
        saves.push(structuredClone(active));
        return value;
      }

      const result = mutationChain.then(() =>
        transaction.run(structuredClone(current), async () => {
          const next = transaction.getStore();
          if (!next) throw new Error("Memory state transaction was not initialized");
          const value = await mutation(next);
          current = structuredClone(next);
          saves.push(structuredClone(next));
          return value;
        }),
      );
      mutationChain = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

export const createFakeState = createMemoryState;
