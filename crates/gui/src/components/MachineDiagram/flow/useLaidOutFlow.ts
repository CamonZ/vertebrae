import { useEffect, useMemo, useState } from "react";
import {
  compileFlow,
  type CompileOptions,
  type CompileResult,
} from "./compile";
import { layoutFrom, needsAutoLayout } from "./layout";
import { LayoutAbortedError, layoutFlowOffThread } from "./layoutClient";

/**
 * Longest a diagram waits for auto-layout before showing the row fallback.
 * Large graphs can route for minutes; the fallback and its retry keep the
 * surface usable, and abandoning the request frees the shared worker.
 */
export const LAYOUT_BUDGET_MS = 30_000;

export type LaidOutFlowState =
  | { readonly status: "pending" }
  | {
      readonly status: "done";
      readonly result: CompileResult;
      readonly fallbackError?: string;
    };

function compileSafely(input: unknown, o: CompileOptions): CompileResult {
  try {
    return compileFlow(input, o);
  } catch (e) {
    return {
      ok: false,
      errors: [{ path: "", message: (e as Error).message || String(e) }],
    };
  }
}

/**
 * Compile a parsed spec and auto-lay out its unplaced parts. Errors and
 * fully hand-placed specs resolve on the first render; otherwise the state is
 * `pending` until the layout worker has placed the parts, so the picture never
 * jumps from the row fallback to its layout. If layout fails, the row
 * fallback is shown, as it is when layout exceeds `budgetMs`.
 * Keep `input` stable (memoize the parse) or the layout reruns every render.
 */
export function useLaidOutFlow(
  input: unknown,
  o: Omit<CompileOptions, "layout"> & {
    readonly budgetMs?: number;
    /** Compose the top level from per-region layouts (region-structured flows). */
    readonly composite?: boolean;
  } = {}
): LaidOutFlowState {
  const budgetMs = o.budgetMs ?? LAYOUT_BUDGET_MS;
  const { registry, composite = false } = o;
  const first = useMemo(
    () => compileSafely(input, { registry }),
    [input, registry]
  );
  const needs = first.ok && needsAutoLayout(first.flow);
  const [laid, setLaid] = useState<{
    readonly from: CompileResult;
    readonly result: CompileResult;
    readonly fallbackError?: string;
  } | null>(null);
  useEffect(() => {
    if (!first.ok || !needs) return;
    let live = true;
    let fallbackError: string | undefined;
    const abort = new AbortController();
    // The budget covers layout work only: a request waiting behind another
    // diagram's layout has not started and must not time out for it.
    const requested = performance.now();
    let started: number | undefined;
    let budget: ReturnType<typeof setTimeout> | undefined;
    const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
    const timing = () => {
      const now = performance.now();
      return started === undefined
        ? `queued ${seconds(now - requested)}`
        : `queued ${seconds(started - requested)}, layout ${seconds(now - started)}`;
    };
    layoutFlowOffThread(first.flow, {
      signal: abort.signal,
      composite,
      onStart: () => {
        started = performance.now();
        budget = setTimeout(() => {
          fallbackError = `Automatic layout took longer than ${seconds(budgetMs)} (${timing()}).`;
          abort.abort();
        }, budgetMs);
      },
    })
      .then((layout) => {
        const r = compileSafely(input, {
          registry,
          layout: layoutFrom(layout),
        });
        return r.ok ? r : first;
      })
      .catch((e: unknown) => {
        if (e instanceof LayoutAbortedError) {
          if (live)
            console.warn("flow auto-layout timed out; using the row layout");
          return first;
        }
        fallbackError = e instanceof Error ? e.message : String(e);
        console.warn("flow auto-layout failed; using the row layout", e);
        return first;
      })
      .then((result) => {
        clearTimeout(budget);
        if (live) {
          console.debug(
            `flow auto-layout: ${first.ok ? first.flow.arrangements[0].parts.length : 0} parts, ${timing()}`
          );
          setLaid({ from: first, result, fallbackError });
        }
      });
    return () => {
      live = false;
      clearTimeout(budget);
      abort.abort();
    };
  }, [first, needs, input, registry, budgetMs, composite]);
  if (!needs) return { status: "done", result: first };
  if (laid?.from === first)
    return {
      status: "done",
      result: laid.result,
      ...(laid.fallbackError ? { fallbackError: laid.fallbackError } : {}),
    };
  return { status: "pending" };
}
