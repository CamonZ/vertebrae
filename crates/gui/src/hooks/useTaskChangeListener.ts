import { useEffect, useCallback } from "react";
import {
  events,
  type TaskChangedEvent,
  type TaskChangeType,
  type TaskRunStepChangedEvent,
  type TaskStepChangedEvent,
} from "../bindings";
import { useToastStore } from "../stores";
import {
  getProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";
import { removeTaskFromQueryCache, upsertTaskInQueryCache } from "../query";
import { useRefreshTaskForRealtimeChange } from "./useRefreshTaskForRealtimeChange";

/** Get toast message for task change type */
function getTaskChangeMessage(
  changeType: TaskChangeType,
  taskId: string
): string {
  const shortId = taskId.slice(0, 6);
  switch (changeType) {
    case "Created":
      return `Task ${shortId} created`;
    case "Updated":
      return `Task ${shortId} updated`;
    case "Deleted":
      return `Task ${shortId} deleted`;
    case "StatusChanged":
      return `Task ${shortId} status changed`;
  }
}

/** Options for the task change listener hook */
interface UseTaskChangeListenerOptions {
  /** Whether the listener is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Hook that listens to TaskChangedEvent from Tauri and applies entity data
 * directly to the TanStack Query cache. If a realtime payload is incomplete, the hook
 * hydrates the task before reconciling it into the current list.
 *
 * @param options - Configuration options for the listener
 */
export function useTaskChangeListener(
  options: UseTaskChangeListenerOptions = {}
) {
  const { enabled = true } = options;
  const addToast = useToastStore((state) => state.addToast);
  const projectScopeGeneration = useProjectScopeGeneration();
  const fetchAndReconcileTask =
    useRefreshTaskForRealtimeChange("TaskChangeListener");

  const handleTaskChanged = useCallback(
    (event: { payload: TaskChangedEvent }) => {
      if (projectScopeGeneration !== getProjectScopeGeneration()) return;

      const { task_id, change_type, task, archived } = event.payload;

      console.debug(
        `[TaskChangeListener] Received ${change_type} event for task ${task_id.slice(0, 6)}`
      );

      const toastType =
        change_type === "Created"
          ? "success"
          : change_type === "Deleted"
            ? "error"
            : "info";
      addToast(getTaskChangeMessage(change_type, task_id), toastType);

      if (change_type === "Deleted" || archived) {
        removeTaskFromQueryCache(task_id, projectScopeGeneration);
      } else if (task) {
        if (!task.workflow_name || !task.step_name) {
          void fetchAndReconcileTask(task_id);
        } else {
          upsertTaskInQueryCache(task, projectScopeGeneration);
        }
      } else {
        void fetchAndReconcileTask(task_id);
      }
    },
    [addToast, fetchAndReconcileTask, projectScopeGeneration]
  );

  const handleTaskStepChanged = useCallback(
    (event: { payload: TaskStepChangedEvent | TaskRunStepChangedEvent }) => {
      if (projectScopeGeneration !== getProjectScopeGeneration()) return;
      void fetchAndReconcileTask(event.payload.task_id);
    },
    [fetchAndReconcileTask, projectScopeGeneration]
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const unlistenPromise = events.taskChangedEvent.listen(handleTaskChanged);
    const unlistenTaskStepPromise = events.taskStepChangedEvent.listen(
      handleTaskStepChanged
    );
    const unlistenTaskRunStepPromise = events.taskRunStepChangedEvent.listen(
      handleTaskStepChanged
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
      unlistenTaskStepPromise.then((unlisten) => unlisten());
      unlistenTaskRunStepPromise.then((unlisten) => unlisten());
    };
  }, [enabled, handleTaskChanged, handleTaskStepChanged]);
}
