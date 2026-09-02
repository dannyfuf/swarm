import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { resolveKey } from "../app/keymap.ts";
import {
  selectedRepo,
  selectedWorktree,
  visibleRepoItems,
  visibleWorktrees,
} from "../app/selectors.ts";
import type { AppState, Command, UiDeps, UiExit } from "../core/app.ts";
import type { Repo } from "../core/types.ts";
import { LinesView } from "./components/LineView.tsx";
import { DialogHost } from "./dialogs/index.tsx";
import { useNow, useTick } from "./hooks/timers.ts";
import { isEscape, isQuitKey, toKeyEvent } from "./keys.ts";
import { buildScreen, layoutOf, nextScroll } from "./screen.ts";
import { theme } from "./theme.ts";

export interface AppProps extends UiDeps {
  onExit: (exit: UiExit) => void;
  /** Injected in tests so the screen is deterministic. */
  home?: string;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Base refs we can offer without a `Controller.remoteBranches` port: the repo
 * default plus every ref the existing worktrees were cut from. The base field
 * also accepts free text, so an unknown ref is still reachable.
 */
function knownBaseRefs(state: AppState, repo: Repo): string[] {
  const refs = new Set<string>([`origin/${repo.defaultBranch}`]);
  for (const worktree of state.worktrees) {
    if (worktree.repoId !== repo.id) continue;
    refs.add(worktree.baseRef);
    refs.add(`origin/${worktree.branch}`);
  }
  return [...refs];
}

function repoOfSelection(state: AppState): Repo | undefined {
  const repo = selectedRepo(state);
  if (repo) return repo;
  const worktree = selectedWorktree(state);
  if (!worktree) return undefined;
  return state.repos.find((candidate) => candidate.id === worktree.repoId);
}

export function App({ store, controller, onExit, home = process.env.HOME ?? "" }: AppProps) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const { width, height } = useTerminalDimensions();
  const layout = layoutOf(width, height);
  const now = useNow();
  const tick = useTick(
    state.operations.length > 0 || state.clones.some((clone) => clone.status !== "failed"),
  );
  const pending = useRef("");
  const repoScroll = useRef(0);
  const worktreeScroll = useRef(0);

  const worktrees = visibleWorktrees(state);
  repoScroll.current = nextScroll(
    repoScroll.current,
    state.repoCursor,
    layout.bodyRows,
    visibleRepoItems(state).length + 1,
  );
  worktreeScroll.current = nextScroll(
    worktreeScroll.current,
    state.worktreeCursor,
    layout.listRows,
    worktrees.length,
  );

  useEffect(() => {
    if (state.toasts.length === 0) return;
    const timers = state.toasts.map((toast) =>
      setTimeout(() => store.dispatch({ type: "dismissToast", id: toast.id }), 3200),
    );
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [state.toasts, store]);

  const fail = (error: unknown) => {
    store.dispatch({
      type: "toast",
      toast: { id: `ui-error-${Date.now()}`, level: "error", text: errorText(error) },
    });
  };

  const guard = (task: () => Promise<void>) => {
    task().catch(fail);
  };

  const notify = (text: string) => {
    store.dispatch({
      type: "toast",
      toast: { id: `ui-info-${Date.now()}`, level: "info", text },
    });
  };

  const switchContext = (index: number) => {
    const current = store.getState();
    const target = current.contexts[index];
    if (target) guard(() => controller.setContext(target.id));
  };

  function runCommand(command: Command): void {
    const current = store.getState();
    const halfPage = Math.max(1, Math.floor(layout.listRows / 2));

    if (command.startsWith("context:")) {
      switchContext(Number(command.slice("context:".length)) - 1);
      return;
    }

    switch (command) {
      case "down":
        store.dispatch({ type: "move", delta: 1 });
        return;
      case "up":
        store.dispatch({ type: "move", delta: -1 });
        return;
      case "halfDown":
        store.dispatch({ type: "move", delta: halfPage });
        return;
      case "halfUp":
        store.dispatch({ type: "move", delta: -halfPage });
        return;
      case "top":
        store.dispatch({ type: "moveTo", index: 0 });
        return;
      case "bottom":
        store.dispatch({ type: "moveTo", index: Number.MAX_SAFE_INTEGER });
        return;
      case "left":
        store.dispatch({ type: "focus", pane: "repos" });
        return;
      case "right":
        store.dispatch({ type: "focus", pane: "worktrees" });
        return;
      case "open":
      case "openKeep": {
        if (current.pane === "repos") {
          store.dispatch({ type: "focus", pane: "worktrees" });
          return;
        }
        if (!selectedWorktree(current)) return;
        guard(async () => {
          await controller.openSelected({ sleepPrevious: command === "open" });
          onExit("opened");
        });
        return;
      }
      case "new": {
        if (current.pane === "repos") {
          if (!current.activeContextId) {
            notify("Create a context first with N");
            return;
          }
          store.dispatch({
            type: "openDialog",
            dialog: { kind: "clone-repo", contextId: current.activeContextId },
          });
          return;
        }
        const repo = repoOfSelection(current);
        if (!repo) {
          notify("Select a repo in the left pane first");
          return;
        }
        guard(async () => {
          const remoteBranches = await controller.remoteBranches(repo.id);
          store.dispatch({
            type: "openDialog",
            dialog: {
              kind: "create-worktree",
              repoId: repo.id,
              branches: [...new Set([...remoteBranches, ...knownBaseRefs(current, repo)])],
            },
          });
        });
        return;
      }
      case "newContext":
        store.dispatch({ type: "openDialog", dialog: { kind: "context-form" } });
        return;
      case "delete":
        guard(() => controller.deleteSelected());
        return;
      case "deleteContext": {
        if (!current.activeContextId) return;
        const id = current.activeContextId;
        guard(() => controller.deleteContext(id));
        return;
      }
      case "sleep":
        guard(() => controller.sleepSelected());
        return;
      case "kill":
        guard(() => controller.killSelected());
        return;
      case "move": {
        const repo = repoOfSelection(current);
        if (!repo) {
          notify("Select a repo to move");
          return;
        }
        store.dispatch({
          type: "openDialog",
          dialog: { kind: "assign-context", repoId: repo.id },
        });
        return;
      }
      case "refresh":
        guard(() => controller.refresh());
        return;
      case "filter":
        store.dispatch({ type: "focus", pane: "worktrees" });
        store.dispatch({ type: "setMode", mode: "filter" });
        return;
      case "clearFilter":
        store.dispatch({ type: "setFilter", filter: "" });
        return;
      case "palette":
        store.dispatch({ type: "openDialog", dialog: { kind: "palette" } });
        return;
      case "settings":
        store.dispatch({ type: "openDialog", dialog: { kind: "settings" } });
        return;
      case "help":
        store.dispatch({ type: "openDialog", dialog: { kind: "help" } });
        return;
      case "yank":
        guard(() => controller.yankPath());
        return;
      case "nextContext":
      case "prevContext": {
        const index = current.contexts.findIndex(
          (context) => context.id === current.activeContextId,
        );
        const size = current.contexts.length;
        if (size === 0) return;
        const step = command === "nextContext" ? 1 : -1;
        switchContext(((((index < 0 ? 0 : index) + step) % size) + size) % size);
        return;
      }
      case "quit":
        onExit("quit");
        return;
      default:
        return;
    }
  }

  useKeyboard((raw) => {
    const current = store.getState();
    const event = toKeyEvent(raw);
    if (isQuitKey(event)) {
      raw.preventDefault();
      runCommand("quit");
      return;
    }
    // Dialogs own the keyboard while they are open; each one listens itself.
    if (current.mode === "dialog") return;

    if (current.mode === "filter" && isEscape(event)) {
      raw.preventDefault();
      store.dispatch({ type: "setMode", mode: "normal" });
      return;
    }

    const resolution = resolveKey(current.mode, pending.current, event, {
      hasFilter: current.filter !== "",
    });
    pending.current = resolution.pending;
    if (resolution.command === "none") return;
    raw.preventDefault();
    runCommand(resolution.command);
  });

  const lines = buildScreen(state, {
    width,
    height,
    now,
    tick,
    home,
    repoScroll: repoScroll.current,
    worktreeScroll: worktreeScroll.current,
    ghosted: state.dialog !== undefined,
  });

  const filterLeft = layout.rightColumn + 3;
  const filterWidth = Math.max(8, layout.rightWidth - 14);

  return (
    <box width={width} height={height} flexDirection="column">
      <LinesView lines={lines} />
      {state.mode === "filter" && state.dialog === undefined ? (
        <input
          position="absolute"
          left={filterLeft}
          top={layout.headerRow}
          width={filterWidth}
          focused
          value={state.filter}
          placeholder="branch…"
          onInput={(value: string) => store.dispatch({ type: "setFilter", filter: value })}
          backgroundColor="transparent"
          focusedBackgroundColor="transparent"
          textColor={theme.strong}
          focusedTextColor={theme.strong}
          placeholderColor={theme.ghost}
          cursorColor={theme.accent}
        />
      ) : null}
      {state.dialog ? (
        <DialogHost
          dialog={state.dialog}
          store={store}
          controller={controller}
          onRun={runCommand}
        />
      ) : null}
    </box>
  );
}

export interface RunTuiDeps extends UiDeps {
  home?: string;
}

/**
 * Mount the TUI on a real terminal and resolve once the user leaves: `"quit"`
 * for `q`/`Esc`/`ctrl-c`, `"opened"` after a worktree was mounted and the tmux
 * client switched. The renderer is torn down before resolving so the caller can
 * exit the process (and the tmux popup closes) with a clean terminal.
 */
export async function runTui(deps: RunTuiDeps): Promise<UiExit> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);

  return new Promise<UiExit>((resolve, reject) => {
    let settled = false;
    const finish = (result: { exit: UiExit } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      setTimeout(() => {
        process.off("unhandledRejection", onUnhandledRejection);
        let cleanupError: unknown;
        try {
          root.unmount();
        } catch (error) {
          cleanupError = error;
        }
        try {
          renderer.destroy();
        } catch (error) {
          cleanupError ??= error;
        }

        if ("error" in result) reject(result.error);
        else if (cleanupError !== undefined) reject(cleanupError);
        else resolve(result.exit);
      }, 0);
    };
    const onUnhandledRejection = (error: unknown): void => finish({ error });

    process.once("unhandledRejection", onUnhandledRejection);
    try {
      root.render(<App {...deps} onExit={(exit) => finish({ exit })} />);
    } catch (error) {
      finish({ error });
    }
  });
}
