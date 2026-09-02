import { join } from "node:path";
import { z } from "zod";
import { SwarmError } from "../core/errors.ts";
import type { ConfigPort, FilesPort, Logger } from "../core/ports.ts";
import { type Config, ConfigSchema, defaultConfig } from "../core/types.ts";

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
        const config = defaultConfig(home);
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

      const config = validateConfig(
        deepMerge(defaultConfig(home), parsed),
        `Invalid config file ${path}`,
      );
      return {
        ...config,
        reposDir: expandHome(config.reposDir, userHome),
        worktreesDir: expandHome(config.worktreesDir, userHome),
      };
    },

    async save(config) {
      const validated = validateConfig(config, "Cannot save invalid config");
      await files.writeTextAtomic(path, JSON.stringify(validated, null, 2));
    },
  };
}
