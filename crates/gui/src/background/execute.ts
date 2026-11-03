import type { BackgroundResult, BackgroundTask } from "./types";

/** The worker reuses the canonical parsers; no provider or renderer protocol is reimplemented. */
export async function executeBackgroundTask(
  task: BackgroundTask
): Promise<BackgroundResult> {
  switch (task.kind) {
    case "patch": {
      const { preparePatches } =
        await import("../components/thread/toolChange/preparePatches");

      return { kind: task.kind, value: preparePatches(task) };
    }

    case "tool_chain": {
      const { buildToolChain } =
        await import("../components/thread/toolChange/diffComments");

      return { kind: task.kind, value: buildToolChain(task.annotations) };
    }

    case "replay": {
      const { prepareProviderReplay } =
        await import("../stores/prepareProviderReplay");

      return { kind: task.kind, value: prepareProviderReplay(task.input) };
    }
  }
}
