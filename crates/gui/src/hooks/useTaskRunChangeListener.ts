import { useEffect, useCallback } from "react";
import { events, type TaskRunChangedEvent } from "../bindings";
import {
  getProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";
import {
  hasTaskInQueryCache,
  removeTaskFromQueryCache,
  removeTaskRunsFromQueryCache,
  replaceTaskRunControlsInQueryCache,
  upsertTaskRunInQueryCache,
} from "../query";
import { useRefreshTaskForRealtimeChange } from "./useRefreshTaskForRealtimeChange";

interface UseTaskRunChangeListenerOptions {
  /** Whether the listener is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Applies TaskRun websocket payloads directly to GUI state. The server-provided
 * TaskRun queries are the authority for active-run state. The controls payload
 * only refreshes server-derived eligibility metadata.
 */
export function useTaskRunChangeListener(
  options: UseTaskRunChangeListenerOptions = {}
) {
  const { enabled = true } = options;
  const projectScopeGeneration = useProjectScopeGeneration();
  const fetchAndReconcileTask = useRefreshTaskForRealtimeChange(
    "TaskRunChangeListener"
  );

  const handleTaskRunChanged = useCallback(
    (event: { payload: TaskRunChangedEvent }) => {
      if (projectScopeGeneration !== getProjectScopeGeneration()) return;

      const { task_id, task_run, run_controls } = event.payload;

      if (task_run) {
        upsertTaskRunInQueryCache(task_run, projectScopeGeneration);
      }

      if (run_controls.kind === "deleted") {
        removeTaskRunsFromQueryCache(task_id, projectScopeGeneration);
        removeTaskFromQueryCache(task_id, projectScopeGeneration);
        return;
      }

      const taskWasCached = hasTaskInQueryCache(
        task_id,
        projectScopeGeneration
      );
      if (run_controls.kind === "present") {
        replaceTaskRunControlsInQueryCache(task_id, run_controls.controls, projectScopeGeneration);
      }
      if (!taskWasCached || run_controls.kind === "malformed") {
        void fetchAndReconcileTask(task_id);
      }
    },
    [fetchAndReconcileTask, projectScopeGeneration]
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
