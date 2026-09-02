import { useKeyboard } from "@opentui/react";
import type { DialogKind, Store } from "../../core/app.ts";
import { LinesView } from "../components/LineView.tsx";
import { isEnter, isEscape, toKeyEvent } from "../keys.ts";
import { cell, type Line } from "../text.ts";
import { glyphs, theme } from "../theme.ts";
import { DialogFrame, Spacer } from "./chrome.tsx";

type Confirm = Extract<DialogKind, { kind: "confirm" }>;

export function ConfirmDialog({ dialog, store }: { dialog: Confirm; store: Store }) {
  const close = () => store.dispatch({ type: "closeDialog" });

  useKeyboard((raw) => {
    const event = toKeyEvent(raw);
    if (isEscape(event) || event.name === "n" || event.name === "q") {
      raw.preventDefault();
      close();
      return;
    }
    if (isEnter(event) || event.name === "y") {
      raw.preventDefault();
      dialog.onConfirm();
      close();
    }
  });

  const body: Line[] = dialog.body.map((text) => [
    cell(` ${glyphs.sep} `, { fg: dialog.danger ? theme.red : theme.dim }),
    cell(text, { fg: theme.text }),
  ]);

  return (
    <DialogFrame
      title={dialog.title}
      danger={dialog.danger}
      width={66}
      hints={[
        { key: "y", label: dialog.confirmLabel?.toLowerCase() ?? "confirm" },
        { key: "n / Esc", label: "cancel" },
      ]}
    >
      <Spacer />
      <LinesView lines={body} />
    </DialogFrame>
  );
}
