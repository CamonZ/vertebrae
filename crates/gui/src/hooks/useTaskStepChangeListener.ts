import { useEffect, useCallback, useRef } from "react";
import { events, type TaskStepChangedEvent } from "../bindings";
import { useToastStore } from "../stores";

/** Options for the task step change listener hook */
interface UseTaskStepChangeListenerOptions {
  /** Called when a task's current step changes */
  onTaskStepChange?: (taskId: string, stepId: string, stepName: string) => void;
  /** Whether the listener is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Hook that listens to TaskStepChangedEvent from workflow execution.
 * Emitted when a task's current_step_id is updated during workflow runs.
 *
 * This allows the frontend to update task state directly without refetching
 * when the workflow runner advances to a new step.
 *
 * @param options - Configuration options for the listener
 */
export function useTaskStepChangeListener(
  options: UseTaskStepChangeListenerOptions = {}
) {
  const { onTaskStepChange, enabled = true } = options;
  const addToast = useToastStore((state) => state.addToast);

  // Stable callback ref to avoid effect re-runs
  const onTaskStepChangeRef = useRef(onTaskStepChange);
  onTaskStepChangeRef.current = onTaskStepChange;

  const handleTaskStepChanged = useCallback(
    (event: { payload: TaskStepChangedEvent }) => {
      const { task_id, step_id, step_name } = event.payload;

      console.debug(
        `[TaskStepChangeListener] Task ${task_id.slice(0, 6)} moved to step: ${step_name}`
      );

      addToast(`Task moved to step: ${step_name}`, "info");

      if (onTaskStepChangeRef.current) {
        onTaskStepChangeRef.current(task_id, step_id, step_name);
      }
    },
    [addToast]
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const unlistenPromise = events.taskStepChangedEvent.listen(handleTaskStepChanged);

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [enabled, handleTaskStepChanged]);
}
