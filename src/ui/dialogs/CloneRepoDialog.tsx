import { useKeyboard } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import type { Controller, DialogKind, Store } from "../../core/app.ts";
import type { RemoteRepo } from "../../core/types.ts";
import { LinesView } from "../components/LineView.tsx";
import { relativeTime } from "../format.ts";
import { useDebounced, useTick } from "../hooks/timers.ts";
import { isEnter, isEscape, isListDown, isListUp, toKeyEvent } from "../keys.ts";
import { cell, fitLine, type Line, pad, padStart, truncate } from "../text.ts";
import { glyphs, spinnerFrame, theme } from "../theme.ts";
import {
  DialogFrame,
  FieldLabel,
  SectionLabel,
  Spacer,
  TextField,
  useDialogInnerWidth,
} from "./chrome.tsx";

type CloneRepo = Extract<DialogKind, { kind: "clone-repo" }>;

const VISIBLE_RESULTS = 8;

export function CloneRepoDialog({
  dialog,
  store,
  controller,
}: {
  dialog: CloneRepo;
  store: Store;
  controller: Controller;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RemoteRepo[]>([]);
  const [cursor, setCursor] = useState(0);
  const [searching, setSearching] = useState(true);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const inner = useDialogInnerWidth(78);
  const debounced = useDebounced(query, 150);
  const tick = useTick(searching);
  const submitted = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    let live = true;
    setSearching(true);
    controller
      .searchRemote(debounced, abort.signal)
      .then((found) => {
        if (!live) return;
        setResults(found);
        setCursor(0);
        setFailure(undefined);
      })
      .catch((error: unknown) => {
        if (!live || abort.signal.aborted) return;
        setResults([]);
        setFailure(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (live) setSearching(false);
      });
    return () => {
      live = false;
      abort.abort();
    };
  }, [debounced, controller]);

  const visible = results.slice(0, VISIBLE_RESULTS);
  const clamped = Math.min(cursor, Math.max(0, visible.length - 1));

  useKeyboard((raw) => {
    const event = toKeyEvent(raw);
    if (isEscape(event)) {
      raw.preventDefault();
      store.dispatch({ type: "closeDialog" });
      return;
    }
    if (isListDown(event, true)) {
      raw.preventDefault();
      setCursor((value) => Math.min(value + 1, Math.max(0, visible.length - 1)));
      return;
    }
    if (isListUp(event, true)) {
      raw.preventDefault();
      setCursor((value) => Math.max(0, value - 1));
      return;
    }
    if (isEnter(event)) {
      raw.preventDefault();
      const remote = visible[clamped];
      if (remote && !submitted.current) {
        submitted.current = true;
        store.dispatch({ type: "closeDialog" });
        void controller.cloneRepo(remote);
      }
    }
  });

  const now = Date.now();
  const nameWidth = Math.max(12, Math.min(34, Math.round((inner - 14) * 0.5)));
  const descriptionWidth = Math.max(0, inner - 5 - nameWidth - 1 - 8);
  const rows: Line[] = visible.map((remote, index) => {
    const selected = index === clamped;
    return fitLine(
      [
        cell(selected ? ` ${glyphs.cursor} ` : "   ", { fg: theme.accent }),
        cell(remote.isPrivate ? glyphs.private : glyphs.public, {
          fg: remote.isPrivate ? theme.yellow : theme.dim,
        }),
        cell(" ", {}),
        cell(pad(truncate(remote.fullName, nameWidth), nameWidth), {
          fg: selected ? theme.strong : theme.text,
          bold: selected,
        }),
        cell(" ", {}),
        cell(pad(truncate(remote.description || "—", descriptionWidth), descriptionWidth), {
          fg: theme.dim,
        }),
        cell(padStart(relativeTime(remote.updatedAt, now), 8), { fg: theme.ghost }),
      ],
      inner,
    );
  });

  if (rows.length === 0) {
    rows.push([
      cell("   ", {}),
      searching
        ? cell(`${spinnerFrame(tick)} searching…`, { fg: theme.accent })
        : cell(failure ?? (query === "" ? "no repos left to clone" : "no matches"), {
            fg: failure ? theme.red : theme.dim,
          }),
    ]);
  }

  const context = store.getState().contexts.find((item) => item.id === dialog.contextId);

  return (
    <DialogFrame
      title={`Clone repo ${glyphs.sep} ${context?.name ?? dialog.contextId}`}
      width={78}
      hints={[
        { key: glyphs.enter, label: "clone" },
        { key: "↑↓", label: "select" },
        { key: "Esc", label: "cancel" },
      ]}
    >
      <Spacer />
      <FieldLabel text={`Search ${context?.owners.join(", ") ?? ""}`} focused />
      <TextField value={query} placeholder="repo name" focused onInput={setQuery} />
      <Spacer />
      <SectionLabel
        text={`  ${results.length} REMOTE ${results.length === 1 ? "REPO" : "REPOS"}`}
      />
      <LinesView lines={rows} />
    </DialogFrame>
  );
}
