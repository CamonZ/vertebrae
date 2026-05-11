import { useEffect, useCallback } from "react";
import {
  events,
  type StepExecutionChangedEvent,
  type StepExecutionStatus,
  type StepExecutionChangeType,
} from "../bindings";
import { useExecutionStore, useToastStore } from "../stores";
import {
  getProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";

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

/** Options for the step execution change listener hook */
interface UseStepExecutionChangeListenerOptions {
  /** Whether the listener is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Hook that listens to StepExecutionChangedEvent from Tauri and applies entity data
 * directly to the execution store. No REST refetch is needed since WS payloads
 * carry the full entity.
 *
 * @param options - Configuration options for the listener
 */
export function useStepExecutionChangeListener(
  options: UseStepExecutionChangeListenerOptions = {}
) {
  const { enabled = true } = options;
  const upsertExecution = useExecutionStore((state) => state.upsertExecution);
  const addToast = useToastStore((state) => state.addToast);
  const projectScopeGeneration = useProjectScopeGeneration();

  const handleExecutionChanged = useCallback(
    (event: { payload: StepExecutionChangedEvent }) => {
      if (projectScopeGeneration !== getProjectScopeGeneration()) return;

      const { execution_id, step_name, status, change_type, execution } =
        event.payload;

      console.debug(
        `[StepExecutionChangeListener] Execution ${execution_id.slice(0, 6)} ${change_type}: ${status}`
      );

      const toastType =
        status === "Completed"
          ? "success"
          : status === "Failed"
            ? "error"
            : "info";
      addToast(
        getExecutionChangeMessage(change_type, step_name, status),
        toastType
      );

      if (execution) {
        upsertExecution(execution);
      }
    },
    [addToast, upsertExecution, projectScopeGeneration]
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
