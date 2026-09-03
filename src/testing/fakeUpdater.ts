import type { UpdateEvent, UpdaterPort } from "../core/ports.ts";

export type FakeUpdater = UpdaterPort & { calls: string[] };

export function createFakeUpdater(
  implementation: UpdaterPort["update"] = async (_installRoot, onEvent) => {
    onEvent?.({ type: "step", label: "pulling main…" });
    onEvent?.({ type: "step", label: "installing dependencies…" });
    onEvent?.({ type: "step", label: "building…" });
  },
): FakeUpdater {
  const calls: string[] = [];
  return {
    calls,
    async update(installRoot, onEvent?: (event: UpdateEvent) => void) {
      calls.push(installRoot);
      return implementation(installRoot, onEvent);
    },
  };
}
