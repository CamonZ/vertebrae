import { useEffect, useCallback } from "react";
import { events, type TaskRunChangedEvent } from "../bindings";
import { useTaskRunStore } from "../stores";
import {
  getProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";
import {
  hasTaskInQueryCache,
  replaceTaskRunControlsInQueryCache,
} from "../query";
import { useRefreshTaskForRealtimeChange } from "./useRefreshTaskForRealtimeChange";

interface UseTaskRunChangeListenerOptions {
  /** Whether the listener is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Applies TaskRun websocket payloads directly to GUI state. The server-provided
 * run_controls payload is the source of truth for task row controls in the
 * TanStack Query cache.
 */
export function useTaskRunChangeListener(
  options: UseTaskRunChangeListenerOptions = {}
) {
  const { enabled = true } = options;
  const upsertTaskRun = useTaskRunStore((state) => state.upsertTaskRun);
  const projectScopeGeneration = useProjectScopeGeneration();
  const fetchAndReconcileTask = useRefreshTaskForRealtimeChange(
    "TaskRunChangeListener"
  );

  const handleTaskRunChanged = useCallback(
    (event: { payload: TaskRunChangedEvent }) => {
      if (projectScopeGeneration !== getProjectScopeGeneration()) return;

      const { task_id, task_run, run_controls } = event.payload;

      if (task_run) {
        upsertTaskRun(task_run);
      }

      const taskWasCached = hasTaskInQueryCache(
        task_id,
        projectScopeGeneration
      );
      replaceTaskRunControlsInQueryCache(
        task_id,
        run_controls,
        projectScopeGeneration
      );
      if (!taskWasCached) {
        void fetchAndReconcileTask(task_id);
      }
    },
    [fetchAndReconcileTask, upsertTaskRun, projectScopeGeneration]
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const unlistenPromise =
      events.taskRunChangedEvent.listen(handleTaskRunChanged);

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [enabled, handleTaskRunChanged]);
}
