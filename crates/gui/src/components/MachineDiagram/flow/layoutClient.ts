/**
 * Runs flow auto-layout off the main thread. One shared worker serves every
 * diagram; requests are matched to replies by id. Where workers are not
 * available (tests, non-browser hosts) or the worker fails to start, layout
 * runs on the calling thread instead, so callers always get a layout.
 */
import type { CompiledFlow } from "./compile";
import { layoutFlow, type FlowLayout } from "./layout";

export interface LayoutRequest {
  readonly id: number;
  readonly flow: CompiledFlow;
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

type Pending = {
  readonly resolve: (layout: FlowLayout) => void;
  readonly reject: (error: Error) => void;
};

export function createLayoutClient(
  spawn: (() => LayoutWorker) | undefined
): (flow: CompiledFlow) => Promise<FlowLayout> {
  let worker: LayoutWorker | undefined;
  let nextId = 0;
  const pending = new Map<number, Pending>();
  const failAll = (error: Error) => {
    for (const p of pending.values()) p.reject(error);
    pending.clear();
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
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if ("error" in data) p.reject(new Error(data.error));
      else p.resolve(data.layout);
    };
    worker.onerror = (event) => {
      // A crashed worker loses every request in flight; start a fresh one on
      // the next request rather than leaving later layouts unanswered.
      worker?.terminate();
      worker = undefined;
      failAll(new Error(event.message || "flow layout worker failed"));
    };
    return worker;
  };
  return (flow) => {
    const w = connect();
    if (!w) return layoutFlow(flow);
    const id = nextId++;
    return new Promise<FlowLayout>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.postMessage({ id, flow });
    });
  };
}

/** Lay out a compiled flow in the shared layout worker. */
export const layoutFlowOffThread = createLayoutClient(
  typeof Worker === "undefined"
    ? undefined
    : () =>
        new Worker(new URL("./layout.worker.ts", import.meta.url), {
          type: "module",
        }) as unknown as LayoutWorker
);
