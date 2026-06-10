import { useCallback, useEffect, useRef, useState } from "react";
import { commands, events, type Task } from "../../../bindings";
import {
  getProjectScopeGeneration,
  isCurrentProjectScopeGeneration,
} from "../../../stores/projectScopedStores";

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
 * Unlike `useTasks`, this hook is self-contained (it does not sync the global
 * task store) so the Run Console can hold its own snapshot without perturbing
 * the Tasks page's scoped list.
 */
export function useRunConsoleTasks(): UseRunConsoleTasksResult {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isFetchInFlightRef = useRef(false);
  const hasPendingFetchRef = useRef(false);

  const loadTasks = useCallback(async () => {
    const projectScopeGeneration = getProjectScopeGeneration();
    try {
      const result = await commands.listReady();
      if (!isCurrentProjectScopeGeneration(projectScopeGeneration)) return;
      if (result.status === "ok") {
        setTasks(result.data);
        setError(null);
      } else {
        setError(result.error.message);
      }
    } catch (e) {
      if (isCurrentProjectScopeGeneration(projectScopeGeneration)) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (isCurrentProjectScopeGeneration(projectScopeGeneration)) {
        setIsLoading(false);
      }
    }
  }, []);

  // Single-flight refetch: while a fetch is running, mark a pending request and
  // re-run once on completion so a burst of events collapses to at most one
  // trailing refetch.
  const fetchTasks = useCallback(async () => {
    if (isFetchInFlightRef.current) {
      hasPendingFetchRef.current = true;
      return;
    }
    isFetchInFlightRef.current = true;
    try {
      do {
        hasPendingFetchRef.current = false;
        await loadTasks();
      } while (hasPendingFetchRef.current);
    } finally {
      isFetchInFlightRef.current = false;
    }
  }, [loadTasks]);

  useEffect(() => {
    void fetchTasks();
  }, [fetchTasks]);

  // Debounced realtime refresh. All task-shaped events funnel through one timer.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (cancelled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void fetchTasks();
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
  }, [fetchTasks]);

  return { tasks, isLoading, error, refetch: fetchTasks };
}
