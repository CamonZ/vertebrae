import { executeBackgroundTask } from "./execute";
import type { WorkerRequest, WorkerResponse } from "./types";

/**
 * A `Worker` stand-in that runs the real task executor asynchronously and
 * structured-clones both directions, so component tests exercise the real
 * client, hook and transfer path that jsdom otherwise skips.
 */
export class InProcessWorker {
  static instances: InProcessWorker[] = [];
  /** Requests posted while set are answered with a worker crash. */
  static crash = false;

  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  requests: WorkerRequest["task"]["kind"][] = [];
  terminated = false;

  constructor() {
    InProcessWorker.instances.push(this);
  }

  postMessage(request: WorkerRequest) {
    const { id, task } = structuredClone(request);
    this.requests.push(task.kind);

    if (InProcessWorker.crash) {
      setTimeout(() => this.onerror?.(), 0);
      return;
    }

    void executeBackgroundTask(task)
      .then(
        (result): WorkerResponse => ({ id, status: "ok", result }),
        (error: unknown): WorkerResponse => ({
          id,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        })
      )
      .then((response) => {
        if (this.terminated) return;
        this.onmessage?.(
          new MessageEvent("message", { data: structuredClone(response) })
        );
      });
  }

  terminate() {
    this.terminated = true;
  }

  static reset() {
    InProcessWorker.instances = [];
    InProcessWorker.crash = false;
  }
}
