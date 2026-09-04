import { join, resolve } from "node:path";
import { z } from "zod";
import { SwarmError } from "../core/errors.ts";
import type { ConfigPort, FilesPort, Logger } from "../core/ports.ts";
import { AGENT_NAMES, type Config, ConfigSchema, defaultConfig } from "../core/types.ts";

const LEGACY_AGENT_COMMANDS = new Set<string>(["cc", ...AGENT_NAMES]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(defaults: unknown, override: unknown): unknown {
  if (!isRecord(defaults) || !isRecord(override)) return override;

  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = key in defaults ? deepMerge(defaults[key], value) : value;
  }
  return merged;
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return value;
}

function absolutePaths(config: Config, userHome: string): Config {
  return {
    ...config,
    reposDir: resolve(expandHome(config.reposDir, userHome)),
    worktreesDir: resolve(expandHome(config.worktreesDir, userHome)),
  };
}

function formatValidationError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
  }
  if (error instanceof SyntaxError) return `Invalid JSON: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function validateConfig(value: unknown, action: string): Config {
  try {
    return ConfigSchema.parse(value);
  } catch (cause) {
    throw new SwarmError("validation", `${action}: ${formatValidationError(cause)}`, { cause });
  }
}

function normalizeLegacyAgentWindow(config: Config): Config {
  if (config.windows.some(({ command }) => command.includes("{agent}"))) return config;
  const legacyIndex = config.windows.findIndex(({ command }) => LEGACY_AGENT_COMMANDS.has(command));
  if (legacyIndex === -1) return config;
  return {
    ...config,
    windows: config.windows.map((window, index) =>
      index === legacyIndex ? { ...window, command: "{agent}" } : window,
    ),
  };
}

export function createConfigStore(
  files: FilesPort,
  path: string,
  home: string,
  logger: Logger,
  userHome: string = process.env.HOME ?? home,
): ConfigPort {
  return {
    async load() {
      const text = await files.readText(path);
      if (text === null) {
        const config = absolutePaths(defaultConfig(home), userHome);
        await files.writeTextAtomic(path, JSON.stringify(config, null, 2));
        logger.info("Created default config file", { path });
        return config;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (cause) {
        throw new SwarmError(
          "validation",
          `Invalid config file ${path}: ${formatValidationError(cause)}`,
          { cause },
        );
      }

      const config = normalizeLegacyAgentWindow(
        validateConfig(deepMerge(defaultConfig(home), parsed), `Invalid config file ${path}`),
      );
      return absolutePaths(config, userHome);
    },

    async save(config) {
      const validated = validateConfig(config, "Cannot save invalid config");
      await files.writeTextAtomic(path, JSON.stringify(validated, null, 2));
    },
  };
}
