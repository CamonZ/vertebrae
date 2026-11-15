/**
 * Runs flow auto-layout off the main thread. One shared worker serves every
 * diagram; requests are matched to replies by id. Where workers are not
 * available (tests, non-browser hosts) or the worker fails to start, layout
 * runs on the calling thread instead, so callers always get a layout.
 */
import type { CompiledFlow } from "./compile";
import { layoutFlowComposite } from "./composite";
import { layoutFlow, type FlowLayout } from "./layout";

export interface LayoutRequest {
  readonly id: number;
  readonly flow: CompiledFlow;
  /** Compose the top level from per-region layouts (`layoutFlowComposite`). */
  readonly composite?: boolean;
}

export type LayoutResponse =
  | { readonly id: number; readonly layout: FlowLayout }
  | { readonly id: number; readonly error: string };

/** The subset of `Worker` the client uses, so tests can supply a fake. */
export interface LayoutWorker {
  onmessage: ((event: MessageEvent<LayoutResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: LayoutRequest): void;
  terminate(): void;
}

/** Per-request controls: abandonment, and notice when layout actually begins. */
export interface LayoutRequestOptions {
  readonly signal?: AbortSignal;
  /** Called when the request leaves the queue and layout starts. */
  readonly onStart?: () => void;
  /** Compose the top level from per-region layouts. */
  readonly composite?: boolean;
  /**
   * Background requests (precompute) wait behind every visible diagram's
   * request, so warming caches never delays what the user is looking at.
   */
  readonly priority?: "visible" | "background";
}

type Pending = {
  readonly id: number;
  readonly flow: CompiledFlow;
  readonly composite: boolean;
  readonly background: boolean;
  readonly onStart?: () => void;
  readonly resolve: (layout: FlowLayout) => void;
  readonly reject: (error: Error) => void;
};

/** Rejection reason for a request its caller abandoned. */
export class LayoutAbortedError extends Error {
  constructor() {
    super("flow layout aborted");
    this.name = "LayoutAbortedError";
  }
}

/**
 * The worker receives one request at a time; the rest wait here. A caller
 * that abandons its request (unmount, new input, time budget) removes it from
 * the queue, or, when it is the one being laid out, restarts the worker so a
 * slow layout never holds back the diagrams queued after it.
 */
export function createLayoutClient(
  spawn: (() => LayoutWorker) | undefined
): (flow: CompiledFlow, options?: LayoutRequestOptions) => Promise<FlowLayout> {
  let worker: LayoutWorker | undefined;
  let nextId = 0;
  let inFlight: Pending | undefined;
  const queue: Pending[] = [];
  const stop = () => {
    worker?.terminate();
    worker = undefined;
  };
  const connect = (): LayoutWorker | undefined => {
    if (worker || !spawn) return worker;
    try {
      worker = spawn();
    } catch {
      spawn = undefined;
      return undefined;
    }
    worker.onmessage = ({ data }) => {
      const p = inFlight;
      if (!p || p.id !== data.id) return;
      inFlight = undefined;
      if ("error" in data) p.reject(new Error(data.error));
      else p.resolve(data.layout);
      pump();
    };
    worker.onerror = (event) => {
      // A crashed worker loses the request in flight; start a fresh one for
      // the next request rather than leaving later layouts unanswered.
      stop();
      const p = inFlight;
      inFlight = undefined;
      p?.reject(new Error(event.message || "flow layout worker failed"));
      pump();
    };
    return worker;
  };
  const pump = () => {
    if (inFlight) return;
    const at = queue.findIndex((p) => !p.background);
    const [next] = queue.splice(at >= 0 ? at : 0, 1);
    if (!next) return;
    const w = connect();
    next.onStart?.();
    if (!w) {
      run(next.flow, next.composite).then(next.resolve, next.reject);
      pump();
      return;
    }
    inFlight = next;
    w.postMessage({
      id: next.id,
      flow: next.flow,
      ...(next.composite ? { composite: true } : {}),
    });
  };
  return (flow, { signal, onStart, composite = false, priority } = {}) => {
    if (signal?.aborted) return Promise.reject(new LayoutAbortedError());
    if (!spawn && !worker) {
      onStart?.();
      return run(flow, composite);
    }
    return new Promise<FlowLayout>((resolve, reject) => {
      const p: Pending = {
        id: nextId++,
        flow,
        composite,
        background: priority === "background",
        onStart,
        resolve,
        reject,
      };
      signal?.addEventListener(
        "abort",
        () => {
          const at = queue.indexOf(p);
          if (at >= 0) queue.splice(at, 1);
          else if (inFlight === p) {
            inFlight = undefined;
            stop();
          } else return;
          reject(new LayoutAbortedError());
          pump();
        },
        { once: true }
      );
      queue.push(p);
      pump();
    });
  };
}

const run = (flow: CompiledFlow, composite: boolean) =>
  composite ? layoutFlowComposite(flow) : layoutFlow(flow);

/** Lay out a compiled flow in the shared layout worker. */
export const layoutFlowOffThread = createLayoutClient(
  typeof Worker === "undefined"
    ? undefined
    : () =>
        new Worker(new URL("./layout.worker.ts", import.meta.url), {
          type: "module",
        }) as unknown as LayoutWorker
);
