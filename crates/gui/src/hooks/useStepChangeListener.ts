import { useEffect, useCallback } from "react";
import { events, type Step, type StepChangedEvent, type StepChangeType } from "../bindings";
import { useStepStore, useToastStore } from "../stores";

/** Get toast message for step change type */
function getStepChangeMessage(changeType: StepChangeType, stepId: string): string {
  const shortId = stepId.slice(0, 6);
  switch (changeType) {
    case "Created":
      return `Step ${shortId} created`;
    case "Updated":
      return `Step ${shortId} updated`;
    case "Deleted":
      return `Step ${shortId} deleted`;
  }
}

/** Options for the step change listener hook */
interface UseStepChangeListenerOptions {
  /** Whether the listener is enabled (default: true) */
  enabled?: boolean;
  /** Called after the store is updated when a step is created */
  onCreated?: (step: Step) => void;
  /** Called after the store is updated when a step is updated */
  onUpdated?: (step: Step) => void;
  /** Called after the store is updated when a step is deleted */
  onDeleted?: (stepId: string) => void;
}

/**
 * Hook that listens to StepChangedEvent from Tauri and applies entity data
 * directly to the step store. No REST refetch is needed since WS payloads
 * carry the full entity.
 *
 * Optional callbacks allow callers to also update local derived state
 * (e.g. AllWorkflowsPipeline's workflowStepsMap) without a round-trip refetch.
 *
 * @param options - Configuration options for the listener
 */
export function useStepChangeListener(
  options: UseStepChangeListenerOptions = {}
) {
  const { enabled = true, onCreated, onUpdated, onDeleted } = options;
  const upsertStep = useStepStore((state) => state.upsertStep);
  const removeStep = useStepStore((state) => state.removeStep);
  const addToast = useToastStore((state) => state.addToast);

  const handleStepChanged = useCallback(
    (event: { payload: StepChangedEvent }) => {
      const { step_id, change_type, step } = event.payload;

      console.debug(
        `[StepChangeListener] Received ${change_type} event for step ${step_id.slice(0, 6)}`
      );

      const toastType = change_type === "Created" ? "success"
        : change_type === "Deleted" ? "error"
        : "info";
      addToast(getStepChangeMessage(change_type, step_id), toastType);

      if (change_type === "Deleted") {
        removeStep(step_id);
        onDeleted?.(step_id);
      } else if (step) {
        upsertStep(step);
        if (change_type === "Created") {
          onCreated?.(step);
        } else {
          onUpdated?.(step);
        }
      }
    },
    [addToast, upsertStep, removeStep, onCreated, onUpdated, onDeleted]
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const unlistenPromise = events.stepChangedEvent.listen(handleStepChanged);

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [enabled, handleStepChanged]);
}
