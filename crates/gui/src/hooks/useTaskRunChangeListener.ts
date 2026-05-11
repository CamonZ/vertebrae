import { useEffect, useCallback } from "react";
import { events, type TaskRunChangedEvent } from "../bindings";
import { useTaskRunStore, useTaskStore } from "../stores";
import {
  getProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";

interface UseTaskRunChangeListenerOptions {
  /** Whether the listener is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Applies TaskRun websocket payloads directly to GUI state. The server-provided
 * run_controls payload is the source of truth for task row controls.
 */
export function useTaskRunChangeListener(
  options: UseTaskRunChangeListenerOptions = {}
) {
  const { enabled = true } = options;
  const upsertTaskRun = useTaskRunStore((state) => state.upsertTaskRun);
  const replaceTaskRunControls = useTaskStore(
    (state) => state.replaceTaskRunControls
  );
  const projectScopeGeneration = useProjectScopeGeneration();

  const handleTaskRunChanged = useCallback(
    (event: { payload: TaskRunChangedEvent }) => {
      if (projectScopeGeneration !== getProjectScopeGeneration()) return;

      const { task_id, task_run, run_controls } = event.payload;

      if (task_run) {
        upsertTaskRun(task_run);
      }

      replaceTaskRunControls(task_id, run_controls);
    },
    [replaceTaskRunControls, upsertTaskRun, projectScopeGeneration]
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
