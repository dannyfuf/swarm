import { useKeyboard } from "@opentui/react";
import type { Store } from "../../core/app.ts";
import { LinesView } from "../components/LineView.tsx";
import { isEnter, isEscape, toKeyEvent } from "../keys.ts";
import { cell, fitLine, type Line, padStart } from "../text.ts";
import { theme } from "../theme.ts";
import { DialogFrame, SectionLabel, Spacer, useDialogInnerWidth } from "./chrome.tsx";

const KEY_WIDTH = 11;

function entry(keys: string, label: string): Line {
  return [
    cell(padStart(keys, KEY_WIDTH), { fg: theme.accent, bold: true }),
    cell("  ", {}),
    cell(label, { fg: theme.text }),
  ];
}

const LEFT_COLUMN: Line[] = [
  entry("j / ↓", "Move down"),
  entry("k / ↑", "Move up"),
  entry("gg / G", "Top / bottom"),
  entry("ctrl-d/u", "Half page"),
  entry("h / l", "Repos / worktrees"),
  entry("Tab", "Switch pane"),
  entry("⏎ / o", "Open worktree"),
  entry("O", "Open, keep previous"),
  entry("y", "Copy worktree path"),
  entry("r", "Refresh"),
  entry("q / Esc", "Quit"),
];

const RIGHT_COLUMN: Line[] = [
  entry("n", "New worktree / clone"),
  entry("N", "New context"),
  entry("d", "Delete selected"),
  entry("D", "Delete context"),
  entry("s / K", "Sleep / kill session"),
  entry("m", "Move repo to context"),
  entry("gt / gT", "Next / prev context"),
  entry("1 - 9", "Nth context"),
  entry("p", "Pull requests"),
  entry("/ / :", "Filter / commands"),
  entry(", / ?", "Settings / help"),
];

const PR_LEFT_COLUMN: Line[] = [
  entry("⏎ / o", "Open or create worktree"),
  entry("O", "Open, keep previous"),
  entry("Tab / h l", "Switch tab"),
  entry("b / y", "Browser / copy URL"),
];

const PR_RIGHT_COLUMN: Line[] = [
  entry("/", "Filter pull requests"),
  entry("r", "Force refresh scope"),
  entry("1-9 gt gT", "Context (rescopes)"),
  entry("p / q / Esc", "Back to worktrees"),
];

const FILTER_COLUMN: Line[] = [
  entry("type", "Filter worktrees"),
  entry("⏎", "Open the selected match"),
  entry("Esc", "Keep filter, leave input"),
  entry("Esc", "Again clears the filter"),
];

const DIALOG_COLUMN: Line[] = [
  entry("Esc", "Cancel"),
  entry("⏎", "Confirm"),
  entry("Tab", "Next field"),
  entry("ctrl-n/p", "Next / previous item"),
];

function twoColumns(left: Line[], right: Line[], columnWidth: number): Line[] {
  const rows = Math.max(left.length, right.length);
  const result: Line[] = [];
  for (let index = 0; index < rows; index += 1) {
    result.push([
      ...fitLine(left[index] ?? [], columnWidth),
      ...fitLine(right[index] ?? [], columnWidth),
    ]);
  }
  return result;
}

export function HelpDialog({ store }: { store: Store }) {
  const inner = useDialogInnerWidth(78);
  useKeyboard((raw) => {
    const event = toKeyEvent(raw);
    if (isEscape(event) || isEnter(event) || event.name === "q" || event.name === "?") {
      raw.preventDefault();
      store.dispatch({ type: "closeDialog" });
    }
  });

  const columnWidth = Math.floor(inner / 2);

  return (
    <DialogFrame title="Keymap" width={78} hints={[{ key: "Esc", label: "close" }]}>
      <Spacer />
      <SectionLabel text="  NORMAL" />
      <LinesView lines={twoColumns(LEFT_COLUMN, RIGHT_COLUMN, columnWidth)} />
      <Spacer />
      <SectionLabel text="  PULL REQUESTS" />
      <LinesView lines={twoColumns(PR_LEFT_COLUMN, PR_RIGHT_COLUMN, columnWidth)} />
      <Spacer />
      <LinesView
        lines={[
          [
            ...fitLine([cell("  FILTER", { fg: theme.dim, bold: true })], columnWidth),
            ...fitLine([cell("  DIALOGS", { fg: theme.dim, bold: true })], columnWidth),
          ],
        ]}
      />
      <LinesView lines={twoColumns(FILTER_COLUMN, DIALOG_COLUMN, columnWidth)} />
    </DialogFrame>
  );
}
