import { useEffect, useCallback } from "react";
import { events, type TaskRunChangedEvent } from "../bindings";
import {
  getProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";
import {
  replaceTaskRunControlsInQueryCache,
  upsertTaskRunInQueryCache,
} from "../query";

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

  const handleTaskRunChanged = useCallback(
    (event: { payload: TaskRunChangedEvent }) => {
      if (projectScopeGeneration !== getProjectScopeGeneration()) return;

      const { task_id, task_run, run_controls } = event.payload;

      if (task_run) {
        upsertTaskRunInQueryCache(task_run, projectScopeGeneration);
      }

      if (run_controls.kind === "present") {
        replaceTaskRunControlsInQueryCache(
          task_id,
          run_controls.controls,
          projectScopeGeneration
        );
      } else {
        console.error(
          `[TaskRunChangeListener] Missing valid run_controls projection for ${task_id}`
        );
      }
    },
    [projectScopeGeneration]
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
