import { useEffect, useMemo, useState } from "react";
import { backgroundClient } from "./client";
import type { BackgroundTask, TaskOutput } from "./types";

interface Request<T extends BackgroundTask> {
  task: T;
  attempt: number;
}

interface Prepared<T extends BackgroundTask> {
  request: Request<T>;
  value?: TaskOutput<T>;
  error?: string;
}

/** Retire stale work; a worker failure is surfaced rather than retried on the UI thread. */
export function useBackgroundTask<T extends BackgroundTask>(
  task: T | null,
  inline: (task: T) => TaskOutput<T>
) {
  const supported = typeof Worker !== "undefined";
  const [prepared, setPrepared] = useState<Prepared<T>>();
  const [attempt, setAttempt] = useState(0);

  const request = useMemo(
    () => (task ? { task, attempt } : null),
    [task, attempt]
  );

  const inlineOutcome = useMemo(() => {
    if (supported || !request) return {};

    try {
      return { value: inline(request.task) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [supported, request, inline]);

  useEffect(() => {
    if (!supported || !request) return;

    const controller = new AbortController();

    backgroundClient.run(request.task, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setPrepared({ request, value });
      },
      (error) => {
        if (!controller.signal.aborted)
          setPrepared({
            request,
            error: error instanceof Error ? error.message : String(error),
          });
      }
    );

    return () => controller.abort();
  }, [supported, request]);

  const retry = () => setAttempt((value) => value + 1);

  if (!supported)
    return {
      value: inlineOutcome.value,
      pending: false,
      error: inlineOutcome.error,
      retry,
    };

  const current = prepared?.request === request;

  return {
    value: current ? prepared?.value : undefined,
    pending: request !== null && !current,
    error: current ? prepared?.error : undefined,
    retry,
  };
}
