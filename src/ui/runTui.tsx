import {
  BoxRenderable,
  CliRenderEvents,
  type CliRenderer,
  createCliRenderer,
  TextRenderable,
} from "@opentui/core";
import type { Store, UiDeps, UiExit } from "../core/app.ts";
import { noStartupTiming, type StartupTiming } from "../core/startup.ts";

export interface LoadedTuiDeps extends UiDeps {
  home?: string;
  startup?: StartupTiming;
  initialize?: () => Promise<void>;
}

export type RunTuiDeps =
  | LoadedTuiDeps
  | {
      startup?: StartupTiming;
      load: () => Promise<LoadedTuiDeps>;
    };

interface FirstFrameSource {
  once(event: CliRenderEvents.FRAME, listener: () => void): unknown;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function startInitialization(store: Store, initialize: () => Promise<void>): void {
  void initialize().catch((error: unknown) => {
    const text = errorText(error);
    if (store.getState().error === text) return;
    store.dispatch({ type: "setError", error: text });
    store.dispatch({
      type: "toast",
      toast: { id: `init-error-${Date.now()}`, level: "error", text },
    });
  });
}

export function createStartupView(renderer: CliRenderer): BoxRenderable {
  const view = new BoxRenderable(renderer, {
    id: "startup",
    width: "100%",
    height: "100%",
    border: true,
    borderColor: "#3b4261",
    title: " swarm ",
    titleColor: "#7aa2f7",
    padding: 1,
  });
  view.add(
    new TextRenderable(renderer, {
      content: "Loading workspace…",
      fg: "#5d6689",
    }),
  );
  return view;
}

export function afterFirstFrame(
  renderer: FirstFrameSource,
  startup: StartupTiming,
  callback: () => void,
): void {
  renderer.once(CliRenderEvents.FRAME, () => {
    startup.mark("ui.firstFrame");
    callback();
  });
}

/**
 * Paint a lightweight startup frame before loading the full application module.
 * Controller initialization and the full UI import begin only after that frame.
 */
export async function runTui(deps: RunTuiDeps): Promise<UiExit> {
  const startup = deps.startup ?? noStartupTiming;
  const load = "load" in deps ? deps.load : async () => deps;
  const renderer = await startup.measure("ui.rendererCreate", () =>
    createCliRenderer({ exitOnCtrlC: false }),
  );
  const startupView = createStartupView(renderer);
  let root: ReturnType<typeof import("@opentui/react")["createRoot"]> | undefined;

  return new Promise<UiExit>((resolve, reject) => {
    let settled = false;
    const finish = (result: { exit: UiExit } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      setTimeout(() => {
        process.off("unhandledRejection", onUnhandledRejection);
        let cleanupError: unknown;
        try {
          root?.unmount();
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
    afterFirstFrame(renderer, startup, () => {
      const loaded = load().then((appDeps) => {
        startInitialization(appDeps.store, appDeps.initialize ?? (async () => undefined));
        return appDeps;
      });
      const application = startup.measure("ui.appModuleImport", () =>
        Promise.all([import("@opentui/react"), import("react"), import("./App.tsx")]),
      );
      void Promise.all([loaded, application])
        .then(([appDeps, [{ createRoot }, { createElement }, { App }]]) => {
          if (settled) return;
          renderer.root.remove(startupView);
          startupView.destroyRecursively();
          root = createRoot(renderer);
          renderer.once(CliRenderEvents.FRAME, () => startup.mark("ui.appFrame"));
          root.render(
            createElement(App, {
              store: appDeps.store,
              controller: appDeps.controller,
              config: appDeps.config,
              home: appDeps.home,
              onExit: (exit: UiExit) => finish({ exit }),
            }),
          );
        })
        .catch((error: unknown) => finish({ error }));
    });
    try {
      startup.mark("ui.rootRender");
      renderer.root.add(startupView);
    } catch (error) {
      finish({ error });
    }
  });
}
