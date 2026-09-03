import { useKeyboard } from "@opentui/react";
import { useMemo, useRef, useState } from "react";
import type { Controller, DialogKind, Store } from "../../core/app.ts";
import { fuzzyFilter } from "../../core/fuzzy.ts";
import { slugify } from "../../core/paths.ts";
import { LinesView } from "../components/LineView.tsx";
import { isEnter, isEscape, isListDown, isListUp, isTab, toKeyEvent } from "../keys.ts";
import { cell, highlight, type Line, truncate } from "../text.ts";
import { glyphs, theme } from "../theme.ts";
import { DialogFrame, FieldLabel, SectionLabel, Spacer, TextField } from "./chrome.tsx";

type CreateWorktree = Extract<DialogKind, { kind: "create-worktree" }>;

const VISIBLE_BRANCHES = 6;

export function CreateWorktreeDialog({
  dialog,
  store,
  controller,
}: {
  dialog: CreateWorktree;
  store: Store;
  controller: Controller;
}) {
  const state = store.getState();
  const repo = state.repos.find((candidate) => candidate.id === dialog.repoId);
  const fallbackBase = `origin/${repo?.defaultBranch ?? "main"}`;

  const [branch, setBranch] = useState("");
  const [baseQuery, setBaseQuery] = useState("");
  const [field, setField] = useState<"branch" | "base">("branch");
  const [cursor, setCursor] = useState(0);
  const submitted = useRef(false);

  const matches = useMemo(() => {
    const pool = dialog.branches.length > 0 ? dialog.branches : [fallbackBase];
    return fuzzyFilter(baseQuery, pool, (value) => value).slice(0, VISIBLE_BRANCHES);
  }, [dialog.branches, baseQuery, fallbackBase]);

  const clampedCursor = Math.min(cursor, Math.max(0, matches.length - 1));
  const baseRef = baseQuery === "" ? fallbackBase : (matches[clampedCursor]?.item ?? baseQuery);

  const close = () => store.dispatch({ type: "closeDialog" });

  const submit = () => {
    if (branch.trim() === "" || submitted.current) return;
    submitted.current = true;
    close();
    void controller.createWorktree({ repoId: dialog.repoId, branch: branch.trim(), baseRef });
  };

  useKeyboard((raw) => {
    const event = toKeyEvent(raw);
    if (isEscape(event)) {
      raw.preventDefault();
      close();
      return;
    }
    if (isTab(event)) {
      raw.preventDefault();
      setField((current) => (current === "branch" ? "base" : "branch"));
      return;
    }
    if (isEnter(event)) {
      raw.preventDefault();
      submit();
      return;
    }
    if (isListDown(event, true)) {
      raw.preventDefault();
      setField("base");
      setCursor((value) => Math.min(value + 1, Math.max(0, matches.length - 1)));
      return;
    }
    if (isListUp(event, true)) {
      raw.preventDefault();
      setField("base");
      setCursor((value) => Math.max(0, value - 1));
    }
  });

  const slug = branch.trim() === "" ? "" : slugify(branch.trim());
  const preview: Line[] = [
    [
      cell("  ", {}),
      cell(glyphs.arrow, { fg: theme.dim }),
      cell(" ", {}),
      cell(
        slug === ""
          ? "name the branch to create"
          : `${repo?.owner ?? "?"}/${repo?.name ?? "?"}/${slug}`,
        { fg: slug === "" ? theme.ghost : theme.cyan },
      ),
    ],
  ];

  const list: Line[] = matches.map((match, index) => {
    const active = index === clampedCursor;
    const selected = active && field === "base";
    const style = {
      fg: selected ? theme.strong : active ? theme.text : theme.muted,
      bold: selected,
    };
    return [
      cell(active ? ` ${glyphs.cursor} ` : "   ", { fg: selected ? theme.accent : theme.dim }),
      ...highlight(truncate(match.item, 48), match.positions, style, {
        fg: theme.yellow,
        bold: true,
      }),
    ];
  });
  if (list.length === 0) {
    list.push([
      cell("   ", {}),
      cell(`use “${truncate(baseQuery, 40)}” as base`, { fg: theme.dim }),
    ]);
  }

  return (
    <DialogFrame
      title={`New worktree ${glyphs.sep} ${repo?.name ?? dialog.repoId}`}
      width={72}
      hints={[
        { key: glyphs.tab, label: "field" },
        { key: glyphs.enter, label: "create" },
        { key: "↑↓", label: "base ref" },
        { key: "Esc", label: "cancel" },
      ]}
    >
      <Spacer />
      <FieldLabel text="Branch" focused={field === "branch"} />
      <TextField
        value={branch}
        placeholder="feat/payroll-fix"
        focused={field === "branch"}
        onInput={setBranch}
      />
      <LinesView lines={preview} />
      <Spacer />
      <FieldLabel text={`Base ref ${glyphs.sep} ${baseRef}`} focused={field === "base"} />
      <TextField
        value={baseQuery}
        placeholder={fallbackBase}
        focused={field === "base"}
        onInput={(value) => {
          setBaseQuery(value);
          setCursor(0);
        }}
      />
      <Spacer />
      <SectionLabel text={`  BRANCHES${dialog.fetching ? ` ${glyphs.sep} fetching…` : ""}`} />
      <LinesView lines={list} />
    </DialogFrame>
  );
}
