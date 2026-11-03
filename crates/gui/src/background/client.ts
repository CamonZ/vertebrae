import { taskWeight } from "./budget";
import type {
  BackgroundResult,
  BackgroundTask,
  TaskOutput,
  WorkerResponse,
} from "./types";

/** Bounds the data structured-cloned into the worker for a single job. */
const MAX_JOB_BYTES = 32 * 1024 * 1024;
const JOB_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 5_000;

interface ClientOptions {
  /**
   * Deadline for one job, or `null` for work whose owner always cancels it
   * when the result stops mattering (history replay).
   */
  timeoutMs?: number | null;
}

interface Job {
  id: number;
  task: BackgroundTask;
  /** Set when the caller stops waiting; the outcome is discarded on arrival. */
  canceled: boolean;
  resolve(result: BackgroundResult): void;
  reject(error: Error): void;
  release(): void;
}

const canceledError = () =>
  new DOMException("Preparation canceled.", "AbortError");

/**
 * One shared worker runs jobs in FIFO order. Waiting jobs only reference data
 * their callers already hold, and every caller retires its job on abort, so the
 * queue is bounded by mounted consumers rather than by a count cap that would
 * reject legitimate concurrent work (for example a many-file edit).
 *
 * Canceling the running job does not terminate the worker: respawning it and
 * re-importing the parsers costs more than letting a short job finish. Only a
 * deadline, crash or decode failure replaces the worker.
 */
export function createBackgroundClient(
  createWorker: () => Worker,
  { timeoutMs = JOB_TIMEOUT_MS }: ClientOptions = {}
) {
  let worker: Worker | undefined;
  let active: Job | undefined;
  let queue: Job[] = [];
  let nextId = 1;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;

  const terminate = () => {
    clearTimeout(idle);
    clearTimeout(deadline);

    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      worker = undefined;
    }
  };

  const finish = (job: Job, error?: Error, result?: BackgroundResult) => {
    clearTimeout(deadline);
    active = undefined;

    if (!job.canceled) {
      job.release();
      if (error) job.reject(error);
      else if (result) job.resolve(result);
    }

    pump();
  };

  const fail = (error: Error) => {
    const job = active;
    terminate();

    if (job) finish(job, error);
  };

  const pump = () => {
    clearTimeout(idle);

    if (active) return;

    const job = queue.shift();
    if (!job) {
      idle = setTimeout(() => {
        if (!active && queue.length === 0) terminate();
      }, IDLE_TIMEOUT_MS);
      return;
    }

    active = job;

    try {
      if (!worker) {
        const created = createWorker();
        worker = created;

        created.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
          if (worker !== created) return;

          const current = active;
          if (!current || data.id !== current.id) return;

          if (data.status === "error") {
            finish(current, new Error(data.error));
          } else if (data.result.kind !== current.task.kind) {
            fail(
              new Error(
                "Background response does not match the requested operation."
              )
            );
          } else {
            finish(current, undefined, data.result);
          }
        };

        created.onerror = () => {
          if (worker === created)
            fail(new Error("Background preparation worker failed."));
        };

        created.onmessageerror = () => {
          if (worker === created)
            fail(new Error("Background result could not be decoded."));
        };
      }

      if (timeoutMs !== null)
        deadline = setTimeout(() => {
          if (active?.id === job.id)
            fail(new Error("Background preparation timed out."));
        }, timeoutMs);

      worker.postMessage({ id: job.id, task: job.task });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  };

  return {
    run<T extends BackgroundTask>(
      task: T,
      signal?: AbortSignal
    ): Promise<TaskOutput<T>> {
      if (signal?.aborted) return Promise.reject(canceledError());

      let bytes: number;
      try {
        bytes = taskWeight(task, MAX_JOB_BYTES);
      } catch (error) {
        return Promise.reject(error);
      }

      if (bytes > MAX_JOB_BYTES) {
        return Promise.reject(
          new Error("This content is too large to prepare in the background.")
        );
      }

      const promise = new Promise<BackgroundResult>((resolve, reject) => {
        const id = nextId++;

        const cancel = () => {
          if (active?.id === id) {
            // Stop waiting now; the worker's eventual outcome is discarded.
            active.canceled = true;
            active.release();
            active.reject(canceledError());
            return;
          }

          const index = queue.findIndex((job) => job.id === id);
          if (index === -1) return;

          const [job] = queue.splice(index, 1);
          job.release();
          job.reject(canceledError());
        };

        const job: Job = {
          id,
          task,
          canceled: false,
          resolve,
          reject,
          release: () => signal?.removeEventListener("abort", cancel),
        };

        queue.push(job);
        signal?.addEventListener("abort", cancel, { once: true });

        pump();
      });

      return promise.then((result) => result.value as TaskOutput<T>);
    },

    dispose() {
      terminate();

      const jobs = [...queue, ...(active && !active.canceled ? [active] : [])];
      queue = [];
      active = undefined;

      for (const job of jobs) {
        job.release();
        job.reject(
          new DOMException("Preparation client disposed.", "AbortError")
        );
      }
    },
  };
}

const spawnWorker = () =>
  new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

/** Viewport-driven work (diffs, tool chains) with a per-job deadline. */
export const backgroundClient = createBackgroundClient(spawnWorker);

/**
 * History replay runs on its own worker so a large transcript never delays
 * diffs. It has no fixed deadline: replay ownership aborts it when the session
 * is replaced, cleared or re-requested, and the idle timer retires the worker.
 */
export const replayClient = createBackgroundClient(spawnWorker, {
  timeoutMs: null,
});
