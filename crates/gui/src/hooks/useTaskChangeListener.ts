import { useEffect, useCallback } from "react";
import {
  events,
  type Task,
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
import {
  queryClient,
  queryKeys,
  removeTaskFromQueryCache,
  upsertTaskInQueryCache,
} from "../query";
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

function cachedTasksFor(taskId: string, generation: number): Task[] {
  const detail = queryClient.getQueryData<Task>(
    queryKeys.tasks.detail(generation, taskId)
  );
  const lists = queryClient.getQueriesData<Task[]>({
    queryKey: queryKeys.tasks.lists(generation),
  });
  const ready = queryClient.getQueryData<Task[]>(
    queryKeys.tasks.ready(generation)
  );

  return [
    ...(detail ? [detail] : []),
    ...lists.flatMap(([, tasks]) =>
      (tasks ?? []).filter((task) => task.id === taskId)
    ),
    ...(ready ?? []).filter((task) => task.id === taskId),
  ];
}

function hasSuspiciousEmptyArrayPayload(task: Task, generation: number) {
  const cachedTasks = cachedTasksFor(task.id, generation);
  return cachedTasks.some(
    (cachedTask) =>
      (task.sections !== undefined &&
        task.sections.length === 0 &&
        (cachedTask.sections?.length ?? 0) > 0) ||
      (task.code_refs !== undefined &&
        task.code_refs.length === 0 &&
        (cachedTask.code_refs?.length ?? 0) > 0) ||
      (task.dependency_ids !== undefined &&
        task.dependency_ids.length === 0 &&
        (cachedTask.dependency_ids?.length ?? 0) > 0) ||
      (task.tags !== undefined &&
        task.tags.length === 0 &&
        (cachedTask.tags?.length ?? 0) > 0)
  );
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
        if (
          !task.workflow_name ||
          !task.step_name ||
          hasSuspiciousEmptyArrayPayload(task, projectScopeGeneration)
        ) {
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
