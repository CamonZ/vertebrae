import { useEffect, useCallback } from "react";
import {
  events,
  type TaskChangedEvent,
  type TaskChangeType,
  type TaskRunStepChangedEvent,
  type TaskStepChangedEvent,
} from "../bindings";
import { useNotificationStore } from "../stores";
import {
  getProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";
import {
  removeTaskFromQueryCache,
  updateTaskLocationInQueryCache,
  upsertTaskInQueryCache,
} from "../query";

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
 * Hook that listens to complete TaskChangedEvent projections from Tauri and
 * applies them directly to the TanStack Query cache.
 *
 * @param options - Configuration options for the listener
 */
export function useTaskChangeListener(
  options: UseTaskChangeListenerOptions = {}
) {
  const { enabled = true } = options;
  const addNotification = useNotificationStore(
    (state) => state.addNotification
  );
  const projectScopeGeneration = useProjectScopeGeneration();

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
      addNotification({
        message: getTaskChangeMessage(change_type, task_id),
        type: toastType,
        entity: "task",
        entityId: task_id,
      });

      if (change_type === "Deleted" || archived) {
        removeTaskFromQueryCache(task_id, projectScopeGeneration);
      } else if (task) {
        upsertTaskInQueryCache(task, projectScopeGeneration);
      } else {
        console.error(
          `[TaskChangeListener] Missing task projection for ${task_id}`
        );
      }
    },
    [addNotification, projectScopeGeneration]
  );

  const handleTaskStepChanged = useCallback(
    (event: { payload: TaskStepChangedEvent | TaskRunStepChangedEvent }) => {
      if (projectScopeGeneration !== getProjectScopeGeneration()) return;
      const payload = event.payload;
      updateTaskLocationInQueryCache(
        payload.task_id,
        payload.to_step_id,
        "workflow_id" in payload ? payload.workflow_id : undefined,
        projectScopeGeneration
      );
    },
    [projectScopeGeneration]
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
