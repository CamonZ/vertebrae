import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { commands, events, type Task } from "../../../bindings";
import {
  errorMessage,
  queryClient,
  queryKeys,
  unwrapCommand,
} from "../../../query";
import { useProjectScopeGeneration } from "../../../stores/projectScopedStores";

/** Debounce window for collapsing a burst of realtime events into one refetch. */
const REFRESH_DEBOUNCE_MS = 150;

export interface UseRunConsoleTasksResult {
  tasks: Task[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Task feed for the Run Console.
 *
 * Loads the ready task feed (`listReady()`) — the same dependency-aware set
 * `vtb ready` uses: not completed, no incomplete blockers, not archived. The
 * console splits that set into Running (has an active run) and Ready (launchable
 * head). It stays fresh by refetching on the SAME realtime events
 * `usePipelineSummary` reacts to (task / task-run / task-step changes). The
 * events are coalesced through a single debounced refetch path — this is one
 * extra fetcher, not a second poller, and never fires per-event.
 *
 * TanStack Query owns the ready feed so realtime task/run-control payloads can
 * update this surface immediately, without waiting for the debounced refetch.
 */
export function useRunConsoleTasks(): UseRunConsoleTasksResult {
  const projectScopeGeneration = useProjectScopeGeneration();
  const queryKey = useMemo(
    () => queryKeys.tasks.ready(projectScopeGeneration),
    [projectScopeGeneration]
  );
  const query = useQuery({
    queryKey,
    queryFn: () => unwrapCommand(commands.listReady()),
  });
  const { data, error, isLoading, refetch: refetchQuery } = query;

  const refetch = useCallback(() => {
    void refetchQuery();
  }, [refetchQuery]);

  const invalidateReadyTasks = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
  }, [queryKey]);

  // Debounced realtime refresh. All task-shaped events funnel through one timer.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (cancelled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        invalidateReadyTasks();
      }, REFRESH_DEBOUNCE_MS);
    };

    const unlistenPromises = [
      events.taskChangedEvent.listen(schedule),
      events.taskRunChangedEvent.listen(schedule),
      events.taskRunStepChangedEvent.listen(schedule),
      events.taskStepChangedEvent.listen(schedule),
    ];

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unlistenPromises.forEach((promise) => {
        void promise.then((unlisten) => unlisten()).catch(() => {});
      });
    };
  }, [invalidateReadyTasks]);

  return {
    tasks: data ?? [],
    isLoading,
    error: error ? errorMessage(error) : null,
    refetch,
  };
}
