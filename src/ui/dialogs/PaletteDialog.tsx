import { useKeyboard } from "@opentui/react";
import { useMemo, useState } from "react";
import { COMMANDS } from "../../app/keymap.ts";
import type { Command, Store } from "../../core/app.ts";
import { fuzzyFilter } from "../../core/fuzzy.ts";
import { LinesView } from "../components/LineView.tsx";
import { isEnter, isEscape, isListDown, isListUp, toKeyEvent } from "../keys.ts";
import { cell, fitLine, highlight, type Line, pad, padStart, truncate } from "../text.ts";
import { glyphs, theme } from "../theme.ts";
import { DialogFrame, FieldLabel, Spacer, TextField, useDialogInnerWidth } from "./chrome.tsx";

const VISIBLE = 10;

interface PaletteItem {
  command: Command;
  label: string;
  keys: string;
}

export function PaletteDialog({
  store,
  onRun,
}: {
  store: Store;
  onRun: (command: Command) => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const state = store.getState();
  const inner = useDialogInnerWidth(70);

  const items = useMemo<PaletteItem[]>(() => {
    const contextItems: PaletteItem[] = state.contexts.map((context, index) => ({
      command: `context:${index + 1}` as Command,
      label: `Switch to ${context.name}`,
      keys: `${index + 1}`,
    }));
    // A command the current screen cannot run has no business being listed.
    const available = COMMANDS.filter((command) => command.screens.includes(state.screen));
    return [...available, ...contextItems];
  }, [state.contexts, state.screen]);

  const matches = useMemo(
    () => fuzzyFilter(query, items, (item) => item.label).slice(0, VISIBLE),
    [query, items],
  );
  const clamped = Math.min(cursor, Math.max(0, matches.length - 1));

  useKeyboard((raw) => {
    const event = toKeyEvent(raw);
    if (isEscape(event)) {
      raw.preventDefault();
      store.dispatch({ type: "closeDialog" });
      return;
    }
    if (isListDown(event, true)) {
      raw.preventDefault();
      setCursor((value) => Math.min(value + 1, Math.max(0, matches.length - 1)));
      return;
    }
    if (isListUp(event, true)) {
      raw.preventDefault();
      setCursor((value) => Math.max(0, value - 1));
      return;
    }
    if (isEnter(event)) {
      raw.preventDefault();
      const item = matches[clamped]?.item;
      store.dispatch({ type: "closeDialog" });
      if (item) onRun(item.command);
    }
  });

  const keysWidth = 16;
  const labelWidth = Math.max(10, inner - 3 - keysWidth);
  const rows: Line[] = matches.map((match, index) => {
    const selected = index === clamped;
    const style = { fg: selected ? theme.strong : theme.text, bold: selected };
    return fitLine(
      [
        cell(selected ? ` ${glyphs.cursor} ` : "   ", { fg: theme.accent }),
        ...highlight(
          pad(truncate(match.item.label, labelWidth), labelWidth),
          match.positions,
          style,
          {
            fg: theme.yellow,
            bold: true,
          },
        ),
        cell(padStart(match.item.keys, keysWidth), { fg: theme.dim }),
      ],
      inner,
    );
  });

  if (rows.length === 0) {
    rows.push([cell("   ", {}), cell("no command matches", { fg: theme.dim })]);
  }

  return (
    <DialogFrame
      title="Commands"
      width={70}
      hints={[
        { key: glyphs.enter, label: "run" },
        { key: "↑↓", label: "select" },
        { key: "Esc", label: "cancel" },
      ]}
    >
      <Spacer />
      <FieldLabel text="Run a command" focused />
      <TextField
        value={query}
        placeholder="type to filter"
        focused
        onInput={(value) => {
          setQuery(value);
          setCursor(0);
        }}
      />
      <Spacer />
      <LinesView lines={rows} />
    </DialogFrame>
  );
}
