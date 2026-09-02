import { useKeyboard } from "@opentui/react";
import { useRef, useState } from "react";
import type { Controller, DialogKind, Store } from "../../core/app.ts";
import { LinesView } from "../components/LineView.tsx";
import { isEnter, isEscape, isListDown, isListUp, toKeyEvent } from "../keys.ts";
import { cell, fitLine, type Line, pad, truncate } from "../text.ts";
import { glyphs, theme } from "../theme.ts";
import { DialogFrame, SectionLabel, Spacer, useDialogInnerWidth } from "./chrome.tsx";

type AssignContext = Extract<DialogKind, { kind: "assign-context" }>;

export function AssignContextDialog({
  dialog,
  store,
  controller,
}: {
  dialog: AssignContext;
  store: Store;
  controller: Controller;
}) {
  const state = store.getState();
  const repo = state.repos.find((candidate) => candidate.id === dialog.repoId);
  const contexts = state.contexts;
  const inner = useDialogInnerWidth(64);
  const [cursor, setCursor] = useState(() =>
    Math.max(
      0,
      contexts.findIndex((context) => context.id === repo?.contextId),
    ),
  );
  const clamped = Math.min(cursor, Math.max(0, contexts.length - 1));
  const submitted = useRef(false);

  useKeyboard((raw) => {
    const event = toKeyEvent(raw);
    if (isEscape(event)) {
      raw.preventDefault();
      store.dispatch({ type: "closeDialog" });
      return;
    }
    if (isListDown(event, false)) {
      raw.preventDefault();
      setCursor((value) => Math.min(value + 1, Math.max(0, contexts.length - 1)));
      return;
    }
    if (isListUp(event, false)) {
      raw.preventDefault();
      setCursor((value) => Math.max(0, value - 1));
      return;
    }
    if (isEnter(event)) {
      raw.preventDefault();
      const target = contexts[clamped];
      if (target && repo && !submitted.current) {
        submitted.current = true;
        store.dispatch({ type: "closeDialog" });
        void controller.assignRepo(repo.id, target.id);
      }
    }
  });

  const nameWidth = Math.max(10, Math.min(22, Math.round((inner - 12) * 0.4)));
  const ownersWidth = Math.max(0, inner - 3 - nameWidth - 9);
  const rows: Line[] = contexts.map((context, index) => {
    const selected = index === clamped;
    const current = context.id === repo?.contextId;
    return fitLine(
      [
        cell(selected ? ` ${glyphs.cursor} ` : "   ", { fg: theme.accent }),
        cell(pad(truncate(context.name, nameWidth), nameWidth), {
          fg: selected ? theme.strong : theme.text,
          bold: selected,
        }),
        cell(pad(truncate(context.owners.join(", "), ownersWidth), ownersWidth), { fg: theme.dim }),
        cell(current ? "current" : "", { fg: theme.green }),
      ],
      inner,
    );
  });

  return (
    <DialogFrame
      title={`Move ${repo?.name ?? dialog.repoId} to…`}
      width={64}
      hints={[
        { key: glyphs.enter, label: "move" },
        { key: "↑↓", label: "select" },
        { key: "Esc", label: "cancel" },
      ]}
    >
      <Spacer />
      <SectionLabel text="  CONTEXTS" />
      <LinesView lines={rows} />
    </DialogFrame>
  );
}
