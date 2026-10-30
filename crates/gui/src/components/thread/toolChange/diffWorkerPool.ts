import { getOrCreateWorkerPoolSingleton } from "@pierre/diffs/worker";

/**
 * Off-main-thread syntax highlighting. With a pool, Pierre paints plain diff
 * lines as soon as its theme loads and swaps in highlighted tokens when a
 * worker finishes, instead of tokenizing every diff on the main thread first.
 * Created once and kept for the app's lifetime; absent where Workers are not
 * available (tests), in which case Pierre highlights on the main thread.
 */
export const diffWorkerPool =
  typeof Worker === "undefined"
    ? undefined
    : getOrCreateWorkerPoolSingleton({
        poolOptions: {
          workerFactory: () =>
            new Worker(new URL("./diffWorker.ts", import.meta.url), {
              type: "module",
            }),
          poolSize: 4,
        },
        highlighterOptions: {},
      });

/** Start loading the theme and workers before the first diff mounts. */
export function warmDiffRenderer(): void {
  diffWorkerPool?.initialize().catch(() => undefined);
}
