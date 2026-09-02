import type { Command, Controller, DialogKind, Store } from "../../core/app.ts";
import { AssignContextDialog } from "./AssignContextDialog.tsx";
import { CloneRepoDialog } from "./CloneRepoDialog.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { ContextFormDialog } from "./ContextFormDialog.tsx";
import { CreateWorktreeDialog } from "./CreateWorktreeDialog.tsx";
import { HelpDialog } from "./HelpDialog.tsx";
import { PaletteDialog } from "./PaletteDialog.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";

export function DialogHost({
  dialog,
  store,
  controller,
  onRun,
}: {
  dialog: DialogKind;
  store: Store;
  controller: Controller;
  onRun: (command: Command) => void;
}) {
  switch (dialog.kind) {
    case "confirm":
      return <ConfirmDialog dialog={dialog} store={store} />;
    case "create-worktree":
      return <CreateWorktreeDialog dialog={dialog} store={store} controller={controller} />;
    case "clone-repo":
      return <CloneRepoDialog dialog={dialog} store={store} controller={controller} />;
    case "context-form":
      return <ContextFormDialog dialog={dialog} store={store} controller={controller} />;
    case "assign-context":
      return <AssignContextDialog dialog={dialog} store={store} controller={controller} />;
    case "settings":
      return <SettingsDialog store={store} controller={controller} />;
    case "help":
      return <HelpDialog store={store} />;
    case "palette":
      return <PaletteDialog store={store} onRun={onRun} />;
  }
}
