import { useEffect, useMemo, useState } from "react";
import {
  compileFlow,
  type CompileOptions,
  type CompileResult,
} from "./compile";
import { layoutFlow, layoutFrom, needsAutoLayout } from "./layout";

export type LaidOutFlowState =
  | { readonly status: "pending" }
  | { readonly status: "done"; readonly result: CompileResult };

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
 * `pending` until ELK has placed the parts, so the picture never jumps from
 * the row fallback to its layout. If layout fails, the row fallback is shown.
 * Keep `input` stable (memoize the parse) or the layout reruns every render.
 */
export function useLaidOutFlow(
  input: unknown,
  o: Omit<CompileOptions, "layout"> = {}
): LaidOutFlowState {
  const { registry } = o;
  const first = useMemo(
    () => compileSafely(input, { registry }),
    [input, registry]
  );
  const needs = first.ok && needsAutoLayout(first.flow);
  const [laid, setLaid] = useState<{
    readonly from: CompileResult;
    readonly result: CompileResult;
  } | null>(null);
  useEffect(() => {
    if (!first.ok || !needs) return;
    let live = true;
    layoutFlow(first.flow)
      .then((layout) => {
        const r = compileSafely(input, {
          registry,
          layout: layoutFrom(layout),
        });
        return r.ok ? r : first;
      })
      .catch((e: unknown) => {
        console.warn("flow auto-layout failed; using the row layout", e);
        return first;
      })
      .then((result) => {
        if (live) setLaid({ from: first, result });
      });
    return () => {
      live = false;
    };
  }, [first, needs, input, registry]);
  if (!needs) return { status: "done", result: first };
  if (laid?.from === first) return { status: "done", result: laid.result };
  return { status: "pending" };
}
