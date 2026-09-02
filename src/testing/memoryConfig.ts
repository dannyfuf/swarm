import type { ConfigPort } from "../core/ports.ts";
import { type Config, defaultConfig } from "../core/types.ts";

export type MemoryConfig = ConfigPort & {
  readonly config: Config;
  readonly saves: Config[];
};

export function createMemoryConfig(
  initial: Config = defaultConfig("/home/test/.swarm"),
): MemoryConfig {
  let current = structuredClone(initial);
  const saves: Config[] = [];
  return {
    get config() {
      return current;
    },
    saves,
    async load() {
      return structuredClone(current);
    },
    async save(config) {
      current = structuredClone(config);
      saves.push(structuredClone(config));
    },
  };
}

export const createFakeConfig = createMemoryConfig;
