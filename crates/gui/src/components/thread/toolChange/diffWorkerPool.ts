import { getOrCreateWorkerPoolSingleton } from "@pierre/diffs/worker";
import { useUIStore } from "../../../stores/uiStore";
import {
  CODE_HIGHLIGHTER,
  codeThemePair,
  resolveDiffPreferences,
} from "../../../utils/codeAppearance";

type UIState = ReturnType<typeof useUIStore.getState>;

/**
 * Render options the pool owns: with a working pool Pierre reads the theme
 * and inline change highlighting from here, not from component options.
 */
function poolRenderOptions(state: UIState) {
  return {
    theme: codeThemePair(state.codeThemeDark, state.codeThemeLight),
    lineDiffType: resolveDiffPreferences(state.diffPreferences).lineDiffType,
  };
}

/**
 * Off-main-thread syntax highlighting for Pierre diffs and fenced code
 * blocks. With a pool, Pierre paints plain lines as soon as its theme loads
 * and swaps in highlighted tokens when a worker finishes, instead of
 * tokenizing everything on the main thread first. Small inputs highlight on
 * the main thread so streaming snippets do not flash plain text. Created once
 * and kept for the app's lifetime; absent where Workers are not available
 * (tests), in which case Pierre highlights on the main thread.
 *
 * The pool owns the effective theme, highlighter and inline change
 * highlighting for every component that uses it.
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
          mainThreadMaxCharacters: 4_000,
        },
        highlighterOptions: {
          preferredHighlighter: CODE_HIGHLIGHTER,
          ...poolRenderOptions(useUIStore.getState()),
        },
      });

// Keep the pool and its workers on the shared options. Pierre clears its
// caches and drops in-flight results when they change, so a worker result
// rendered with the previous theme is never applied.
if (diffWorkerPool) {
  useUIStore.subscribe((state, previous) => {
    const next = poolRenderOptions(state);
    const prior = poolRenderOptions(previous);
    if (
      next.theme === prior.theme &&
      next.lineDiffType === prior.lineDiffType
    ) {
      return;
    }
    diffWorkerPool
      .setRenderOptions(next)
      .catch((error: unknown) =>
        console.error("Could not apply code theme:", error)
      );
  });
}

/** Start loading the theme and workers before the first diff mounts. */
export function warmDiffRenderer(): void {
  diffWorkerPool?.initialize().catch(() => undefined);
}
