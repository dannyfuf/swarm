import { useKeyboard } from "@opentui/react";
import { useRef, useState } from "react";
import type { Controller, DialogKind, Store } from "../../core/app.ts";
import { slugify } from "../../core/paths.ts";
import { LinesView } from "../components/LineView.tsx";
import { isEnter, isEscape, isTab, toKeyEvent } from "../keys.ts";
import { cell, type Line } from "../text.ts";
import { glyphs, theme } from "../theme.ts";
import { DialogFrame, FieldLabel, Spacer, TextField } from "./chrome.tsx";

type ContextForm = Extract<DialogKind, { kind: "context-form" }>;

export function ContextFormDialog({
  dialog,
  store,
  controller,
}: {
  dialog: ContextForm;
  store: Store;
  controller: Controller;
}) {
  const existing = store.getState().contexts.find((context) => context.id === dialog.contextId);
  const [name, setName] = useState(existing?.name ?? "");
  const [owners, setOwners] = useState(existing?.owners.join(", ") ?? "");
  const [field, setField] = useState<"name" | "owners">("name");
  const submitted = useRef(false);

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed === "" || submitted.current) return;
    submitted.current = true;
    store.dispatch({ type: "closeDialog" });
    void controller.saveContext({
      id: existing?.id,
      name: trimmed,
      owners: owners
        .split(",")
        .map((owner) => owner.trim())
        .filter((owner) => owner !== ""),
    });
  };

  useKeyboard((raw) => {
    const event = toKeyEvent(raw);
    if (isEscape(event)) {
      raw.preventDefault();
      store.dispatch({ type: "closeDialog" });
      return;
    }
    if (isTab(event)) {
      raw.preventDefault();
      setField((current) => (current === "name" ? "owners" : "name"));
      return;
    }
    if (isEnter(event)) {
      raw.preventDefault();
      submit();
    }
  });

  const preview: Line[] = [
    [
      cell("  ", {}),
      cell(glyphs.arrow, { fg: theme.dim }),
      cell(" id ", { fg: theme.dim }),
      cell(name.trim() === "" ? "…" : slugify(name.trim()), {
        fg: name.trim() === "" ? theme.ghost : theme.cyan,
      }),
    ],
  ];

  return (
    <DialogFrame
      title={existing ? `Edit context ${glyphs.sep} ${existing.name}` : "New context"}
      width={60}
      hints={[
        { key: glyphs.tab, label: "field" },
        { key: glyphs.enter, label: "save" },
        { key: "Esc", label: "cancel" },
      ]}
    >
      <Spacer />
      <FieldLabel text="Name" focused={field === "name"} />
      <TextField value={name} placeholder="Buk" focused={field === "name"} onInput={setName} />
      <LinesView lines={preview} />
      <Spacer />
      <FieldLabel text="GitHub owners (comma separated)" focused={field === "owners"} />
      <TextField
        value={owners}
        placeholder="bukhr, dannyfuf"
        focused={field === "owners"}
        onInput={setOwners}
      />
    </DialogFrame>
  );
}
