# Implementation Plan: TUI Visual Redesign & DX Overhaul

Generated: 2026-03-26

## Summary

The Swarm TUI (a Git worktree + Docker container manager) currently has an "old terminal" aesthetic with hardcoded colors, basic ASCII spinners, flat text layouts, and a raw utilitarian feel. This plan redesigns the visual layer to create a modern, polished developer tool experience — think lazygit, k9s, or OpenCode-level UI quality — while maintaining maximum rendering performance and zero perceived lag.

**What**: Overhaul the visual design system (theme, layout, typography, components, animations) across all 12 component files.
**Why**: A worktree/container manager is used dozens of times daily; the UI should feel fast, elegant, and information-dense without being cluttered. First impressions and ergonomics matter for developer adoption.

## Prerequisites

### Environment Setup
- **Runtime**: Bun (latest) — `bun --version`
- **Project dir**: `tui/` within the repo root
- **Install deps**: `cd tui && bun install`
- **Run the TUI**: `bun run src/index.tsx` (requires git repos in configured working dir)
- **Run tests**: `bun test`
- **Typecheck**: `tsc --noEmit` (from `tui/`)
- **Lint**: `bunx biome check .` (from `tui/`)

### Project Structure Knowledge
```
tui/src/
├── index.tsx              # Entry point — creates renderer, wires services
├── App.tsx                # Root orchestrator (1041 lines) — 3-panel layout + overlays
├── components/            # 12 UI components (this is where most work happens)
│   ├── ActivityOverlay.tsx # Floating activity cards (top-right)
│   ├── Badge.tsx          # Badge component (unused, inline strings used instead)
│   ├── DetailView.tsx     # Right panel — worktree detail with key/value rows
│   ├── Dialog.tsx         # Centered confirm/cancel modal
│   ├── HelpDialog.tsx     # Keyboard shortcut reference modal
│   ├── InputDialog.tsx    # Text input modal (branch name)
│   ├── Panel.tsx          # Bordered container with title
│   ├── RepoBrowser.tsx    # Full-screen repo search/clone overlay
│   ├── RepoList.tsx       # Left panel — <select> of repos
│   ├── Spinner.tsx        # ASCII spinner (|/-\) with useSpinnerFrame hook
│   ├── StatusBar.tsx      # Bottom bar — hints/errors/status
│   └── WorktreeList.tsx   # Center panel — <select> of worktrees with badges
├── hooks/                 # useAppState, useKeyboardShortcuts, useServices
├── state/                 # AppContext, actions, appReducer
├── types/                 # Domain types (status.ts has getBadges())
└── utils/                 # Shell, git-parser, slug, activity tracker
```

### Coding Standards
- **Linter**: Biome (`bunx biome check .`) — rules in `tui/biome.json`
- **No default exports**: `"noDefaultExport": "error"` (all named exports)
- **Import types**: `"useImportType": "error"` (use `import type` for type-only)
- **Indent**: 2 spaces, line width 100, double quotes, no semicolons
- **JSX**: `@opentui/react` reconciler — elements are `<box>`, `<text>`, `<span>`, `<select>`, `<input>` — NOT HTML
- **Text styling**: Must use nested `<span>`, `<strong>`, `<em>`, `<u>` inside `<text>` — NOT props on `<text>`

### TUI Framework Capabilities (OpenTUI React)
Key capabilities available for the redesign:
- `<box>` supports: `border`, `borderStyle` (single/double/rounded/bold), `borderColor`, `title`, `titleAlignment`, `backgroundColor`, `paddingX/Y`, `marginX/Y`, `gap`, `flexDirection`, `flexGrow`, `position` (absolute/relative), `zIndex`, `overflow`, `focusable`
- `<scrollbox>` for scrollable areas with styled scrollbars
- `<ascii-font>` for large titles (fonts: tiny/block/slick/shade)
- `<tab-select>` for horizontal tab selection
- `useTerminalDimensions()` for responsive layouts
- `useTimeline()` for smooth animations with easing
- `RGBA` class from `@opentui/core` for programmatic colors

---

## Task Breakdown

### Task 1: Create Theme System
**Complexity**: Medium  
**Dependencies**: None  
**Acceptance Criteria**: A single `theme.ts` file exports all colors, border styles, and spacing constants. No hardcoded color strings remain in any component.

### Task 2: Redesign Panel Component
**Complexity**: Medium  
**Dependencies**: Task 1  
**Acceptance Criteria**: Panels have a refined appearance with title integration into the border (using `<box title=...>`), subtle background tinting for focused panels, and clear visual hierarchy.

### Task 3: Redesign StatusBar
**Complexity**: Medium  
**Dependencies**: Task 1  
**Acceptance Criteria**: Status bar uses structured layout with clear visual zones (mode indicator, message area, shortcut hints), styled key badges, and smooth transitions between states.

### Task 4: Upgrade Spinner & ActivityOverlay  
**Complexity**: Low  
**Dependencies**: Task 1  
**Acceptance Criteria**: Spinner uses Braille/dot pattern instead of `|/-\`. Activity overlay has polished card styling with subtle background. No setInterval jank (spinner interval remains at 80ms which is fine).

### Task 5: Redesign WorktreeList with Rich Badges
**Complexity**: High  
**Dependencies**: Task 1, Task 4  
**Acceptance Criteria**: Worktree items show colored badges as proper `<span>` elements (not string concatenation). Container status badges are color-coded and use Unicode symbols. The `<Badge>` component is actually used.

### Task 6: Redesign DetailView with Sections
**Complexity**: High  
**Dependencies**: Task 1  
**Acceptance Criteria**: Detail view is organized into logical sections (Git Info, Container Info, Timestamps) with section headers, better spacing, and a scrollable layout for overflow. Copy hint is styled as a proper keybinding badge.

### Task 7: Redesign Dialogs (Dialog, InputDialog, HelpDialog)
**Complexity**: Medium  
**Dependencies**: Task 1  
**Acceptance Criteria**: Dialogs have consistent styling with semi-transparent overlay feel (dark bg), better spacing, styled key hints matching StatusBar badge style, and the HelpDialog uses a two-column layout.

### Task 8: Redesign RepoBrowser
**Complexity**: Medium  
**Dependencies**: Task 1  
**Acceptance Criteria**: RepoBrowser has a cleaner search layout, styled availability badges (colored status indicators), and better visual grouping.

### Task 9: Add Responsive Layout Support  
**Complexity**: Medium  
**Dependencies**: Task 2  
**Acceptance Criteria**: The 3-panel layout adapts to terminal width. Below 100 columns, detail panel collapses or percentages adjust. `useTerminalDimensions()` drives layout decisions. No visual breakage at common terminal sizes (80x24, 120x40, 200x60).

### Task 10: Performance Audit & Optimization
**Complexity**: Medium  
**Dependencies**: Tasks 1-9  
**Acceptance Criteria**: All `useMemo` and `useCallback` usage is correct. No unnecessary re-renders from theme access. Spinner interval doesn't cause full-tree re-renders. `React.memo()` wraps pure components where beneficial.

### Task 11: Update Tests
**Complexity**: Medium  
**Dependencies**: Tasks 1-9  
**Acceptance Criteria**: All existing tests pass with updated snapshot expectations. New tests cover theme application. `bun test` exits cleanly with 0 failures.

### Task 12: Lint, Typecheck, Final Polish
**Complexity**: Low  
**Dependencies**: Tasks 1-11  
**Acceptance Criteria**: `bunx biome check .` passes. `tsc --noEmit` passes. No runtime errors on startup.

---

## Implementation Details

### Task 1: Create Theme System

**Create**: `tui/src/theme.ts`

This file centralizes all visual constants. The design philosophy is a dark, muted palette with one strong accent color, using HSL-adjacent thinking for cohesion.

```typescript
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
  bg: "#0d1117",              // GitHub-dark inspired base
  bgSurface: "#161b22",      // Elevated surfaces (panels, cards)
  bgOverlay: "#1c2128",      // Overlay/dialog backgrounds
  bgHighlight: "#1f2937",    // Highlighted rows, hover states

  // Borders
  borderDefault: "#30363d",  // Default border (unfocused)
  borderFocused: "#6366f1",  // Focused panel border (indigo-500)
  borderMuted: "#21262d",    // Very subtle separator

  // Text
  textPrimary: "#e6edf3",    // Primary text (high contrast)
  textSecondary: "#8b949e",  // Secondary/hint text
  textMuted: "#484f58",      // Disabled/placeholder text
  textOnAccent: "#ffffff",   // Text on accent backgrounds

  // Accent (indigo family)
  accent: "#6366f1",         // Primary accent (indigo-500)
  accentBright: "#818cf8",   // Lighter accent for hover/active
  accentDim: "#4338ca",      // Darker accent for backgrounds

  // Semantic
  success: "#3fb950",        // Green — merged, running, success
  warning: "#d29922",        // Amber — uncommitted changes, warnings
  error: "#f85149",          // Red — errors, orphaned, failed
  info: "#58a6ff",           // Blue — unpushed, informational

  // Status-specific
  containerUp: "#3fb950",    // Container running
  containerDown: "#8b949e",  // Container stopped (neutral)
  containerFail: "#f85149",  // Container failed
  containerNone: "#484f58",  // No container
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
  panel: "rounded" as const,      // Panels use rounded
  dialog: "rounded" as const,     // Dialogs use rounded
  activity: "rounded" as const,   // Activity cards use rounded
} as const

// --- Badge Definitions ---
// Upgrade from plain strings to structured badge display

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
```

**Key decisions**:
- Colors are inspired by GitHub's dark theme (Primer) — widely recognized as clean
- Semantic colors are muted (not pure hue) to reduce eye strain
- All values are `as const` for type safety and tree-shaking
- The spinner upgrades from `|/-\` to Braille dots (universally supported in modern terminals)
- Border style is `rounded` everywhere for consistency

**Existing pattern to follow**: The current codebase uses inline strings like `"#6366F1"` — we're extracting these into the theme. See `Panel.tsx:17` for `titleColor = "#6366F1"` and `Dialog.tsx:50` for `borderColor="#6366F1"`.

---

### Task 2: Redesign Panel Component

**Modify**: `tui/src/components/Panel.tsx`

The current Panel renders a `<box border>` with a `<text>` title as a child, then content below it. This wastes a line and doesn't look integrated. OpenTUI's `<box>` supports a native `title` prop that renders the title *inside* the border frame.

**Current** (`Panel.tsx:15-37`):
```tsx
export function Panel({ title, focused, children }: PanelProps) {
  const borderColor = focused ? "#4455FF" : "#555555"
  const titleColor = "#6366F1"
  return (
    <box border borderStyle="rounded" borderColor={borderColor} flexGrow={1} flexDirection="column" paddingX={1}>
      <text>
        <span fg={titleColor}><strong>{title}</strong></span>
      </text>
      <box flexGrow={1} flexDirection="column" marginTop={1}>
        {children}
      </box>
    </box>
  )
}
```

**New design**:
```tsx
import { colors, borders, spacing } from "../theme.js"

interface PanelProps {
  title: string
  focused: boolean
  children: ReactNode
}

export function Panel({ title, focused, children }: PanelProps) {
  return (
    <box
      border
      borderStyle={borders.panel}
      borderColor={focused ? colors.borderFocused : colors.borderDefault}
      backgroundColor={focused ? colors.bgSurface : undefined}
      title={`  ${title}  `}
      titleAlignment="left"
      flexGrow={1}
      flexDirection="column"
      paddingX={spacing.panelPaddingX}
    >
      {children}
    </box>
  )
}
```

**Changes**:
- Uses `title` prop on `<box>` — renders title embedded in the top border line, saving vertical space
- Adds `backgroundColor` when focused for subtle surface elevation
- Removes the extra `<text>` + `marginTop={1}` children wrapper (saves 2 lines of vertical space per panel)
- All colors from theme

**Gotcha**: The `title` prop requires the border to be enabled. Title text includes padding spaces `"  Repos  "` for visual breathing room within the border.

---

### Task 3: Redesign StatusBar

**Modify**: `tui/src/components/StatusBar.tsx`

The current StatusBar is a single `<text>` line with plain text key hints separated by `|`. The redesign creates structured zones with styled key badges.

**Current problems**:
- Key hints are one long string that gets truncated on narrow terminals
- No visual distinction between the key and the action
- Error/status messages have basic coloring

**New design concept**:
```
 ❯ worktrees │  Refreshing repo... │                    Tab switch  n new  d delete  ? help
 └──mode────┘ └──status message──┘  └──────────contextual shortcut badges──────────────────┘
```

Create a helper component `KeyBadge` (inline in StatusBar, not a separate file):

```tsx
function KeyBadge({ keyName, action }: { keyName: string; action: string }) {
  return (
    <text>
      <span fg={colors.accent} bg={colors.bgHighlight}>
        {` ${keyName} `}
      </span>
      <span fg={colors.textSecondary}>{` ${action}`}</span>
    </text>
  )
}
```

The StatusBar layout becomes a `<box flexDirection="row">` with three zones:
1. **Left**: Mode indicator (focused panel name) with accent prefix char `❯`
2. **Center**: Status/error message (flexGrow=1)
3. **Right**: Top 4-6 shortcut badges (context-sensitive, truncated for width)

**Performance note**: The key hints are now memoized per `focusedPanel` value. The `getKeyHints` function returns an array of `{key, action}` objects instead of a concatenated string, so we can render styled `KeyBadge` elements.

Reduce the hint count per panel to the most essential shortcuts:
- **repos**: `Tab` switch, `Enter` select, `c` copy, `?` help
- **worktrees**: `Tab` switch, `n` new, `o` open, `d` delete, `s` start, `?` help  
- **detail**: `Tab` switch, `s` start, `x` stop, `v` inspect, `?` help

This prevents the current problem where worktree hints overflow the terminal width.

---

### Task 4: Upgrade Spinner & ActivityOverlay

**Modify**: `tui/src/components/Spinner.tsx`

Replace the ASCII pipe spinner with Braille dots:

```tsx
import { spinnerFrames, spinnerIntervalMs } from "../theme.js"
// spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
```

The `useSpinnerFrame` hook stays the same structurally (single `setInterval`), just uses the new frames. This is already performant — one interval shared across all spinner instances via the hook being called once in `ActivityOverlay`.

**Modify**: `tui/src/components/ActivityOverlay.tsx`

Update styling to use theme colors:

```tsx
<box
  key={activity.id}
  border
  borderStyle={borders.activity}
  borderColor={colors.borderDefault}
  backgroundColor={colors.bgSurface}
  paddingX={1}
  flexDirection="row"
  gap={1}
>
  <Spinner frame={frame} />
  <text fg={colors.textSecondary}>{truncateActivityLabel(activity.label)}</text>
</box>
```

The "hidden count" overflow indicator also gets theme styling.

---

### Task 5: Redesign WorktreeList with Rich Badges

**Modify**: `tui/src/components/WorktreeList.tsx`  
**Modify**: `tui/src/components/Badge.tsx`  
**Modify**: `tui/src/types/status.ts` (update badge colors to use theme)

**Problem**: Currently `formatWorktreeName()` builds a plain string like `"feature/auth ● ↑ [UP]"` — all coloring is lost because `<select>` options only accept `{ name: string }`. The badges appear as monochrome text inside the select.

**Solution**: Since OpenTUI's `<select>` component accepts `name: string` for display text, we cannot embed JSX styling directly into options. Instead, we improve the text formatting:

1. Use the upgraded Unicode symbols from `theme.ts` (`badgeSymbols`)
2. Format container status with cleaner labels: `▲ UP` instead of `[UP]`, `▽ DOWN` instead of `[DOWN]`
3. Keep `[GONE]` tag for orphaned worktrees (important safety indicator)

Updated `formatWorktreeName`:
```typescript
function formatWorktreeName(
  wt: Worktree,
  status: Status | undefined,
  containerStatus: ContainerRuntimeStatus | undefined,
): string {
  let name = wt.branch || wt.slug

  if (wt.isOrphaned) {
    name = `${name}  ✗ gone`
  }

  if (status) {
    const badges = getBadges(status)
    if (badges.length > 0) {
      name = `${name}  ${badges.map((b) => b.symbol).join(" ")}`
    }
  }

  if (containerStatus) {
    const symbol = getContainerSymbol(containerStatus.state)
    name = `${name}  ${symbol}`
  }

  return name
}

function getContainerSymbol(state: string): string {
  switch (state) {
    case "running": return "▲"
    case "stopped": return "▽"
    case "failed": return "✗"
    case "not-created": return "○"
    default: return "?"
  }
}
```

**The `Badge.tsx` component**: Currently defined but unused. Either:
- (a) Keep it for future use where we can render JSX badges (e.g., in DetailView), or
- (b) Remove it to reduce dead code

Recommendation: **(a) Keep it** — use it in `DetailView` where we render full `<text>` elements and can use `<span fg={badge.color}>`.

Update `types/status.ts` to use theme colors:
```typescript
import { colors } from "../theme.js"

export function getBadges(status: Status): Badge[] {
  const badges: Badge[] = []
  if (status.hasChanges) {
    badges.push({ symbol: "●", color: colors.warning, hint: "uncommitted changes" })
  }
  if (status.hasUnpushed) {
    badges.push({ symbol: "↑", color: colors.info, hint: "unpushed commits" })
  }
  if (status.branchMerged === true) {
    badges.push({ symbol: "✓", color: colors.success, hint: "merged" })
  }
  if (status.isOrphaned) {
    badges.push({ symbol: "✗", color: colors.error, hint: "orphaned" })
  }
  return badges
}
```

---

### Task 6: Redesign DetailView with Sections

**Modify**: `tui/src/components/DetailView.tsx`

The current DetailView is a flat list of key/value pairs. The redesign groups them into logical sections with headers.

**New layout structure**:
```
┌─ Git ──────────────────────────────────┐
│  Branch      feature/auth              │
│  Slug        feature_auth              │
│  Path        /repos/test__wt__auth     │
│  Session     test-repo--wt--auth       │
│  Status      ● uncommitted  ↑ unpushed │
│                                        │
│─ Container ────────────────────────────│
│  State       ▲ running                 │
│  URL         http://127.0.0.1:4301     │
│  Health      healthy                   │
│  Name        swarm-test-auth           │
│  Config      present (node-web)        │
│                                        │
│─ Timestamps ───────────────────────────│
│  Created     Jan 15, 2026 10:00 AM     │
│  Opened      Jan 16, 2026 2:00 PM     │
└────────────────────────────────────────┘
```

Create a `SectionHeader` helper (inline in DetailView):
```tsx
function SectionHeader({ label }: { label: string }) {
  return (
    <text fg={colors.textMuted}>
      <span fg={colors.accent}>
        <strong>{label}</strong>
      </span>
    </text>
  )
}
```

Create a `DetailRow` helper:
```tsx
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <box flexDirection="row">
      <box width={14}>
        <text fg={colors.textSecondary}>{label}</text>
      </box>
      <box flexGrow={1}>
        {typeof children === "string" ? <text fg={colors.textPrimary}>{children}</text> : children}
      </box>
    </box>
  )
}
```

The status badges row uses the `Badge` component for colored rendering:
```tsx
<DetailRow label="Status">
  <text>
    {badges.map((b, i) => (
      <span key={b.hint}>
        <span fg={b.color}>{b.symbol}</span>
        <span fg={colors.textSecondary}>{` ${b.hint}`}</span>
        {i < badges.length - 1 ? "  " : ""}
      </span>
    ))}
  </text>
</DetailRow>
```

**Performance consideration**: The entire DetailView only re-renders when `selectedWorktree`, `status`, `containerStatus`, or `containerConfigSummary` change. These are already properly memoized in `App.tsx:780-802`. No additional optimization needed.

**Hint line**: Replace `<text fg="#888888">Hint: press y to copy config path</text>` with a styled key badge:
```tsx
<box marginTop={1}>
  <text>
    <span fg={colors.accent} bg={colors.bgHighlight}>{" y "}</span>
    <span fg={colors.textMuted}>{" copy config path"}</span>
  </text>
</box>
```

---

### Task 7: Redesign Dialogs

**Modify**: `tui/src/components/Dialog.tsx`  
**Modify**: `tui/src/components/InputDialog.tsx`  
**Modify**: `tui/src/components/HelpDialog.tsx`

All three dialogs share the same pattern: centered modal over a dark background. Unify the styling:

**Shared changes for all dialogs**:
- `backgroundColor="#000000"` → `backgroundColor={colors.bg}` (slightly tinted rather than pure black)
- `borderColor="#6366F1"` → `borderColor={colors.borderFocused}`
- `width={50}` → `width={spacing.dialogWidth}` (or larger for HelpDialog)
- Footer key hints use `KeyBadge`-style formatting

**Dialog.tsx specific**:
- The "Delete" confirm label should be rendered in `colors.error` when `confirmLabel === "Delete"`
- Add a small warning icon before destructive confirmation text

**InputDialog.tsx specific**:
- `backgroundColor="#1a1a2e"` → `backgroundColor={colors.bgSurface}`
- `focusedBackgroundColor="#2a2a4e"` → `focusedBackgroundColor={colors.bgOverlay}`
- `textColor="#FFFFFF"` → `textColor={colors.textPrimary}`

**HelpDialog.tsx specific**:
- The SHORTCUTS table: key column uses `colors.accent` (currently yellow which looks like a warning)
- Increase width to accommodate the two-column table: `width={spacing.dialogWidth + 6}`
- Group shortcuts with section dividers:
  ```
  Navigation
    j / k / Up / Down    Navigate list
    Tab / Shift+Tab      Switch panel
    Enter                Select / Confirm
  
  Worktree
    n                    New worktree
    N                    New worktree + start
    o                    Open in tmux
    d                    Delete worktree
  
  Container
    s                    Start container
    x                    Stop container
    i                    Build repo image
    ...
  ```

---

### Task 8: Redesign RepoBrowser

**Modify**: `tui/src/components/RepoBrowser.tsx`

Changes:
- Replace `"Download Repository"` title with `"Clone Repository"` (matches the action)
- Use theme colors throughout
- Style availability badges:
  - `[INSTALLED]` → `✓ installed` in `colors.success`
  - `[CLONING...]` → `⟳ cloning` in `colors.info`
  - Available repos: no badge
- Width: `width={spacing.repoBrowserWidth}`
- Search input styling from theme
- Footer keys: styled `KeyBadge` pattern

Updated `formatRepoEntry`:
```typescript
function formatRepoEntry(r: BrowsableRepo): string {
  if (r.availability === "installed") return `${r.remote.fullName}  ✓ installed`
  if (r.availability === "cloning") return `${r.remote.fullName}  ⟳ cloning`
  return r.remote.fullName
}
```

---

### Task 9: Add Responsive Layout Support

**Modify**: `tui/src/App.tsx` (render section only, ~lines 814-928)

Use `useTerminalDimensions()` to adapt panel widths:

```tsx
import { useTerminalDimensions } from "@opentui/react"

// Inside App():
const { width: termWidth } = useTerminalDimensions()

// Responsive breakpoints
const isNarrow = termWidth < 100
const isWide = termWidth >= 160

const repoWidth = isNarrow ? "30%" : isWide ? "20%" : "25%"
const worktreeWidth = isNarrow ? "40%" : "35%"
const detailWidth = isNarrow ? "30%" : isWide ? "45%" : "40%"
```

For very narrow terminals (<80), consider hiding the detail panel and showing a minimal 2-column layout. This is a stretch goal — the primary breakpoint is the 100-column threshold.

**Performance note**: `useTerminalDimensions()` only triggers re-renders when the terminal is actually resized. The dimension values should be consumed directly (not via state) to avoid extra renders.

---

### Task 10: Performance Audit & Optimization

**Audit checklist**:

1. **Spinner interval scope**: Verify `useSpinnerFrame()` is only called once in `ActivityOverlay`, not per-activity-card. Current code is correct — the hook is called once and frame is passed as prop to `<Spinner>`.

2. **Theme imports**: Since `theme.ts` exports plain constants (not React state/context), importing theme values does NOT cause re-renders. This is optimal.

3. **Memoize pure components**: Add `React.memo()` to these leaf components:
   - `Panel` — only depends on `title`, `focused`, `children`
   - `StatusBar` — only depends on its 6 props
   - `DetailView` — depends on 5 props
   - `Badge` — depends on single `badge` prop

   Pattern:
   ```tsx
   export const Panel = React.memo(function Panel({ title, focused, children }: PanelProps) {
     // ...
   })
   ```

4. **Avoid object creation in render**: In `WorktreeList`, the `options` array is already memoized. In `App.tsx`, check that callback functions don't create new objects on each render.

5. **Message auto-clear**: Currently error/status messages persist until replaced. Consider adding a 5-second auto-clear via `useEffect` with a timeout in `App.tsx` (clear the message after 5s). This is a UX improvement, not strictly performance, but it prevents stale messages.

**Files to modify**: Various component files (add `React.memo`), potentially `App.tsx` for message auto-clear.

---

### Task 11: Update Tests

**Modify**: `tui/src/__tests__/components/Dialog.test.tsx`  
**Potentially create**: `tui/src/__tests__/theme.test.ts`

The existing tests use `captureCharFrame()` and check for string content (e.g., `expect(frame).toContain("Delete worktree?")`). Since we're changing visual layout but not content text, most tests should still pass. However:

1. **Update assertions** that check for removed text:
   - If `Panel` no longer renders title as a `<text>` child (now uses `title` prop), check that the title still appears in the frame
   - If StatusBar changes from `"Enter: confirm | Esc: cancel"` to a different format, update assertions

2. **Test theme exports**: Simple test that all colors are valid hex strings and all constants are defined.

3. **Test Badge rendering**: If we start using the `Badge.tsx` component in `DetailView`, add a test for it.

**Run command**: `bun test` from `tui/`

---

### Task 12: Lint, Typecheck, Final Polish

**Commands to run** (from `tui/`):
```bash
# Typecheck
tsc --noEmit

# Lint (Biome)
bunx biome check .

# Auto-fix lint issues
bunx biome check --write .

# Run tests
bun test

# Manual test
bun run src/index.tsx
```

**Common issues to watch for**:
- `import type` violations — Biome enforces `useImportType`
- Unused imports after refactoring — Biome warns on `noUnusedImports`
- Default exports — Biome errors on `noDefaultExport`

---

## Testing Strategy

### Unit Tests (Automated)
- **Run**: `bun test` from `tui/`
- **Existing tests** in `tui/src/__tests__/components/Dialog.test.tsx` cover Dialog, InputDialog, HelpDialog, and DetailView
- **Existing tests** in `tui/src/__tests__/components/WorktreeList.test.tsx` and `RepoList.test.tsx`
- After changes, verify all pass. Update string assertions if layout text changed.
- Add a new `theme.test.ts` to validate theme constants are well-formed.

### Manual Testing Steps
1. **Launch**: `bun run src/index.tsx` from `tui/` — verify startup without errors
2. **Panel navigation**: Press `Tab` to cycle between repos/worktrees/detail — verify focus border color changes
3. **Worktree badges**: Select a repo with worktrees — verify badge symbols display correctly  
4. **Detail view**: Navigate to a worktree — verify sections (Git, Container, Timestamps) render
5. **Dialogs**: Press `?` for help, `n` for new worktree input, `d` for delete confirm — verify themed styling
6. **Status bar**: Trigger actions (refresh, copy) — verify styled messages appear
7. **Activity overlay**: Start a long operation (clone, build) — verify spinner animation is smooth
8. **Responsive**: Resize terminal to <100 cols and >160 cols — verify layout adapts
9. **RepoBrowser**: Press `f` — verify styled repo list with availability badges
10. **Edge cases**: Empty repo list, no worktrees, orphaned worktree — verify graceful display

### Verification Commands
```bash
cd tui
tsc --noEmit          # Zero type errors
bunx biome check .    # Zero lint errors
bun test              # All tests pass
bun run src/index.tsx  # Visual smoke test
```

---

## Definition of Done

- [ ] All 12 subtasks completed
- [ ] `theme.ts` created with all visual constants
- [ ] Zero hardcoded color strings remain in components
- [ ] All 12 component files updated to use theme
- [ ] Panel uses `<box title=...>` for space-efficient title rendering
- [ ] StatusBar uses structured key badges
- [ ] Spinner uses Braille dots
- [ ] DetailView organized into sections
- [ ] Dialogs share consistent theme styling
- [ ] Responsive layout for different terminal widths
- [ ] `React.memo()` on leaf components
- [ ] `bun test` — all tests pass
- [ ] `tsc --noEmit` — zero type errors
- [ ] `bunx biome check .` — zero lint errors
- [ ] Manual visual testing confirms polished appearance
- [ ] No perceived lag or UI freezing during normal interaction
