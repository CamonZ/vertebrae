import { useEffect, useCallback, useRef } from "react";
import {
  events,
  type StepExecutionChangedEvent,
  type StepExecutionStatus,
  type StepExecutionChangeType,
} from "../bindings";
import { useToastStore } from "../stores";

/** Options for the step execution change listener hook */
interface UseStepExecutionChangeListenerOptions {
  /** Called when a step execution is created */
  onExecutionCreated?: (
    executionId: string,
    taskId: string,
    workflowId: string,
    stepName: string,
    status: StepExecutionStatus
  ) => void;
  /** Called when a step execution status changes */
  onExecutionStatusChanged?: (
    executionId: string,
    taskId: string,
    newStatus: StepExecutionStatus
  ) => void;
  /** Whether the listener is enabled (default: true) */
  enabled?: boolean;
}

/** Get toast message for execution change */
function getExecutionChangeMessage(
  changeType: StepExecutionChangeType,
  stepName: string,
  status: StepExecutionStatus
): string {
  if (changeType === "Created") {
    return `Started step: ${stepName}`;
  }
  if (status === "Completed") {
    return `Step completed: ${stepName}`;
  }
  if (status === "Failed") {
    return `Step failed: ${stepName}`;
  }
  return `Step ${stepName}: ${status}`;
}

/**
 * Hook that listens to StepExecutionChangedEvent from workflow execution.
 * Emitted when a step execution is created or its status changes.
 *
 * This allows the frontend to update execution state directly without refetching
 * when the workflow runner creates or updates executions.
 *
 * @param options - Configuration options for the listener
 */
export function useStepExecutionChangeListener(
  options: UseStepExecutionChangeListenerOptions = {}
) {
  const { onExecutionCreated, onExecutionStatusChanged, enabled = true } = options;
  const addToast = useToastStore((state) => state.addToast);

  // Stable callback refs to avoid effect re-runs
  const onExecutionCreatedRef = useRef(onExecutionCreated);
  const onExecutionStatusChangedRef = useRef(onExecutionStatusChanged);
  onExecutionCreatedRef.current = onExecutionCreated;
  onExecutionStatusChangedRef.current = onExecutionStatusChanged;

  const handleExecutionChanged = useCallback(
    (event: { payload: StepExecutionChangedEvent }) => {
      const { execution_id, task_id, workflow_id, step_name, status, change_type } =
        event.payload;

      console.debug(
        `[StepExecutionChangeListener] Execution ${execution_id.slice(0, 6)} ${change_type}: ${status}`
      );

      // Show toast with appropriate color
      const toastType =
        status === "Completed" ? "success" : status === "Failed" ? "error" : "info";
      addToast(getExecutionChangeMessage(change_type, step_name, status), toastType);

      if (change_type === "Created" && onExecutionCreatedRef.current) {
        onExecutionCreatedRef.current(
          execution_id,
          task_id,
          workflow_id,
          step_name,
          status
        );
      } else if (change_type === "StatusChanged" && onExecutionStatusChangedRef.current) {
        onExecutionStatusChangedRef.current(execution_id, task_id, status);
      }
    },
    [addToast]
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const unlistenPromise = events.stepExecutionChangedEvent.listen(
      handleExecutionChanged
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [enabled, handleExecutionChanged]);
}
