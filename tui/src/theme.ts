/**
 * Centralized theme for the Swarm TUI.
 *
 * Design principles:
 * - Dark base with high-contrast text
 * - Single accent hue (indigo) for focus/interactive elements
 * - Muted semantic colors (not pure #FF0000 red)
 * - Consistent spacing scale
 */

// --- Color Palette ---

export const colors = {
  // Base
  bg: "#0d1117",
  bgSurface: "#161b22",
  bgOverlay: "#1c2128",
  bgHighlight: "#1f2937",

  // Borders
  borderDefault: "#30363d",
  borderFocused: "#6366f1",
  borderMuted: "#21262d",

  // Text
  textPrimary: "#e6edf3",
  textSecondary: "#8b949e",
  textMuted: "#484f58",
  textOnAccent: "#ffffff",

  // Accent (indigo family)
  accent: "#6366f1",
  accentBright: "#818cf8",
  accentDim: "#4338ca",

  // Semantic
  success: "#3fb950",
  warning: "#d29922",
  error: "#f85149",
  info: "#58a6ff",

  // Status-specific
  containerUp: "#3fb950",
  containerDown: "#8b949e",
  containerFail: "#f85149",
  containerNone: "#484f58",
} as const

// --- Typography/Spacing ---

export const spacing = {
  panelPaddingX: 1,
  panelPaddingY: 0,
  sectionGap: 1,
  dialogWidth: 54,
  dialogPaddingX: 2,
  dialogPaddingY: 1,
  repoBrowserWidth: 72,
} as const

// --- Border Styles ---

export const borders = {
  panel: "rounded" as const,
  dialog: "rounded" as const,
  activity: "rounded" as const,
} as const

// --- Badge Definitions ---

export const badgeSymbols = {
  changes: "●",
  unpushed: "↑",
  merged: "✓",
  orphaned: "✗",
  containerUp: "▲",
  containerDown: "▽",
  containerFail: "✗",
  containerNone: "○",
  installed: "✓",
  cloning: "⟳",
} as const

// --- Spinner ---

export const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const
export const spinnerIntervalMs = 80
