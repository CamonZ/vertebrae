import { useEffect, useCallback } from "react";
import {
  commands,
  events,
  type TaskChangedEvent,
  type TaskChangeType,
  type TaskRunStepChangedEvent,
  type TaskStepChangedEvent,
} from "../bindings";
import { useTaskStore, useToastStore } from "../stores";
import {
  getProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";

const taskRefreshesInFlight = new Set<string>();

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
 * directly to the task store. No REST refetch is needed since WS payloads
 * carry the full entity.
 *
 * @param options - Configuration options for the listener
 */
export function useTaskChangeListener(
  options: UseTaskChangeListenerOptions = {}
) {
  const { enabled = true } = options;
  const reconcileTask = useTaskStore((state) => state.reconcileTask);
  const removeTask = useTaskStore((state) => state.removeTask);
  const addToast = useToastStore((state) => state.addToast);
  const projectScopeGeneration = useProjectScopeGeneration();

  const handleTaskChanged = useCallback(
    (event: { payload: TaskChangedEvent }) => {
      if (projectScopeGeneration !== getProjectScopeGeneration()) return;

      const { task_id, change_type, task } = event.payload;

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

      if (change_type === "Deleted") {
        removeTask(task_id);
      } else if (task) {
        reconcileTask(task);
      }
    },
    [addToast, reconcileTask, removeTask, projectScopeGeneration]
  );

  const fetchAndReconcileTask = useCallback(
    async (taskId: string) => {
      if (taskRefreshesInFlight.has(taskId)) return;
      taskRefreshesInFlight.add(taskId);
      const requestGeneration = projectScopeGeneration;
      try {
        const result = await commands.getTask(taskId);
        if (requestGeneration !== getProjectScopeGeneration()) return;
        if (result.status === "ok") {
          reconcileTask(result.data);
        } else {
          console.warn(
            `[TaskChangeListener] Failed to refresh task ${taskId.slice(0, 6)} after step change: ${result.error.message}`
          );
        }
      } finally {
        taskRefreshesInFlight.delete(taskId);
      }
    },
    [projectScopeGeneration, reconcileTask]
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
    const unlistenTaskStepPromise =
      events.taskStepChangedEvent.listen(handleTaskStepChanged);
    const unlistenTaskRunStepPromise =
      events.taskRunStepChangedEvent.listen(handleTaskStepChanged);

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
      unlistenTaskStepPromise.then((unlisten) => unlisten());
      unlistenTaskRunStepPromise.then((unlisten) => unlisten());
    };
  }, [
    enabled,
    handleTaskChanged,
    handleTaskStepChanged,
  ]);
}
