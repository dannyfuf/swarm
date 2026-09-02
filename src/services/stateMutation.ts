import type { StatePort } from "../core/ports.ts";
import type { State } from "../core/types.ts";

interface TransactionalStatePort extends StatePort {
  mutate<T>(mutation: (state: State) => Promise<T> | T): Promise<T>;
}

const fallbackChains = new WeakMap<StatePort, Promise<void>>();

function isTransactional(state: StatePort): state is TransactionalStatePort {
  return "mutate" in state && typeof state.mutate === "function";
}

export async function mutateState<T>(
  state: StatePort,
  mutation: (state: State) => Promise<T> | T,
): Promise<T> {
  if (isTransactional(state)) return state.mutate(mutation);

  const previous = fallbackChains.get(state) ?? Promise.resolve();
  const result = previous
    .catch(() => undefined)
    .then(async () => {
      const next = await state.load();
      const value = await mutation(next);
      await state.save(next);
      return value;
    });
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  fallbackChains.set(state, tail);
  await tail;
  if (fallbackChains.get(state) === tail) fallbackChains.delete(state);
  return result;
}
