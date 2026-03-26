/**
 * Configuration service for Swarm TUI.
 *
 * Loads configuration from three sources in ascending priority:
 * 1. Built-in defaults
 * 2. YAML config file at `$XDG_CONFIG_HOME/swarm/config.yaml`
 * 3. Environment variables prefixed with `SWARM_`
 *
 * Ports the Go `internal/config/` package (config.go, loader.go, validate.go).
 */

import { parse as parseYaml } from "yaml"
import { type Config, VALID_WORKTREE_PATTERNS, type WorktreePattern } from "../types/config.js"

export class ConfigService {
  private config: Config | null = null

  /**
   * Load and validate configuration, caching the result.
   * Subsequent calls return the cached config.
   */
  async load(): Promise<Config> {
    if (this.config) return this.config

    const defaults = this.getDefaults()
    const fileConfig = await this.loadFromFile()
    const envConfig = this.loadFromEnv()

    // Merge: defaults < file < env (highest priority)
    this.config = { ...defaults, ...fileConfig, ...envConfig }
    this.validate(this.config)
    return this.config
  }

  /** Get the cached config, throwing if load() hasn't been called. */
  get(): Config {
    if (!this.config) {
      throw new Error("ConfigService: config not loaded. Call load() first.")
    }
    return this.config
  }

  private getDefaults(): Config {
    const home = process.env.HOME ?? ""
    const aiWorkingDir = process.env.AI_WORKING_DIR ?? `${home}/amplifier/ai_working`

    return {
      aiWorkingDir,
      defaultBaseBranch: "main",
      worktreePattern: "patternA",
      createSessionOnCreate: true,
      tmuxLayoutScript: "",
      statusCacheTTL: 30_000,
      preferFzf: false,
      autoPruneOnRemove: true,
    }
  }

  private async loadFromFile(): Promise<Partial<Config>> {
    const configDir = process.env.XDG_CONFIG_HOME ?? `${process.env.HOME}/.config`
    const basePath = `${configDir}/swarm/config`

    // Try multiple extensions in priority order
    for (const ext of [".yaml", ".yml"]) {
      const configPath = `${basePath}${ext}`
      try {
        const file = Bun.file(configPath)
        if (!(await file.exists())) continue
        const content = await file.text()
        const raw = parseYaml(content)
        if (!raw || typeof raw !== "object") continue
        return this.mapYamlToConfig(raw as Record<string, unknown>)
      } catch {}
    }

    return {}
  }

  private mapYamlToConfig(raw: Record<string, unknown>): Partial<Config> {
    const config: Partial<Config> = {}

    if (typeof raw.ai_working_dir === "string") {
      config.aiWorkingDir = this.expandHome(raw.ai_working_dir)
    }
    if (typeof raw.default_base_branch === "string") {
      config.defaultBaseBranch = raw.default_base_branch
    }
    if (typeof raw.worktree_pattern === "string") {
      config.worktreePattern = raw.worktree_pattern as WorktreePattern
    }
    if (typeof raw.create_session_on_create === "boolean") {
      config.createSessionOnCreate = raw.create_session_on_create
    }
    if (typeof raw.tmux_layout_script === "string") {
      config.tmuxLayoutScript = this.expandHome(raw.tmux_layout_script)
    }
    if (typeof raw.status_cache_ttl === "number") {
      config.statusCacheTTL = raw.status_cache_ttl
    } else if (typeof raw.status_cache_ttl === "string") {
      config.statusCacheTTL = this.parseDuration(raw.status_cache_ttl)
    }
    if (typeof raw.prefer_fzf === "boolean") {
      config.preferFzf = raw.prefer_fzf
    }
    if (typeof raw.auto_prune_on_remove === "boolean") {
      config.autoPruneOnRemove = raw.auto_prune_on_remove
    }

    return config
  }

  private loadFromEnv(): Partial<Config> {
    const env: Partial<Config> = {}

    if (process.env.SWARM_AI_WORKING_DIR) {
      env.aiWorkingDir = process.env.SWARM_AI_WORKING_DIR
    }
    if (process.env.SWARM_DEFAULT_BASE_BRANCH) {
      env.defaultBaseBranch = process.env.SWARM_DEFAULT_BASE_BRANCH
    }
    if (process.env.SWARM_WORKTREE_PATTERN) {
      env.worktreePattern = process.env.SWARM_WORKTREE_PATTERN as WorktreePattern
    }
    if (process.env.SWARM_CREATE_SESSION_ON_CREATE) {
      env.createSessionOnCreate = process.env.SWARM_CREATE_SESSION_ON_CREATE === "true"
    }
    if (process.env.SWARM_TMUX_LAYOUT_SCRIPT) {
      env.tmuxLayoutScript = process.env.SWARM_TMUX_LAYOUT_SCRIPT
    }
    if (process.env.SWARM_STATUS_CACHE_TTL) {
      const ttl = Number.parseInt(process.env.SWARM_STATUS_CACHE_TTL, 10)
      if (!Number.isNaN(ttl)) env.statusCacheTTL = ttl
    }
    if (process.env.SWARM_PREFER_FZF) {
      env.preferFzf = process.env.SWARM_PREFER_FZF === "true"
    }
    if (process.env.SWARM_AUTO_PRUNE_ON_REMOVE) {
      env.autoPruneOnRemove = process.env.SWARM_AUTO_PRUNE_ON_REMOVE === "true"
    }

    return env
  }

  private validate(config: Config): void {
    if (!VALID_WORKTREE_PATTERNS.includes(config.worktreePattern)) {
      throw new Error(
        `Invalid worktree pattern: "${config.worktreePattern}". ` +
          `Must be one of: ${VALID_WORKTREE_PATTERNS.join(", ")}`,
      )
    }
    // AIWorkingDir existence is validated at runtime when scanning repos,
    // not at config load time (the dir may not exist yet).
  }

  /**
   * Parse a Go-style duration string (e.g. "30s", "5m", "1h") to milliseconds.
   * Falls back to the default TTL on unrecognized input.
   */
  private parseDuration(s: string): number {
    const match = s.match(/^(\d+)(ms|s|m|h)$/)
    if (!match) return 30_000
    const value = Number.parseInt(match[1], 10)
    switch (match[2]) {
      case "ms":
        return value
      case "s":
        return value * 1_000
      case "m":
        return value * 60_000
      case "h":
        return value * 3_600_000
      default:
        return 30_000
    }
  }

  /** Expand `~` prefix to the user's home directory. */
  private expandHome(p: string): string {
    if (p.startsWith("~/")) {
      return `${process.env.HOME}${p.slice(1)}`
    }
    return p
  }
}
