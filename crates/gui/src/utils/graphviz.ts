import type { Graphviz as GraphvizRuntime } from "@hpcc-js/wasm-graphviz";

let graphvizPromise: Promise<GraphvizRuntime> | undefined;

/**
 * Lazily load the local Graphviz WASM runtime.
 *
 * The dynamic import keeps the Graphviz bundle out of the initial GUI chunk.
 * @hpcc-js/wasm-graphviz embeds its WASM binary in that local chunk, so no
 * network request or system Graphviz executable is needed at runtime.
 */
export function loadGraphviz(): Promise<GraphvizRuntime> {
  graphvizPromise ??= import("@hpcc-js/wasm-graphviz")
    .then(({ Graphviz }) => Graphviz.load())
    .catch((error: unknown) => {
      graphvizPromise = undefined;
      throw error;
    });

  return graphvizPromise;
}
