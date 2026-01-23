import { useEffect, useRef, useCallback } from "react";
import { events, type StepChangedEvent, type StepChangeType } from "../bindings";
import { useToastStore } from "../stores";

/** Debounce delay in milliseconds for batching rapid events */
const DEBOUNCE_MS = 100;

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
  /** Called when a specific step should be refetched */
  onStepChange?: (stepId: string) => void;
  /** Called when any step changes to refresh the workflow */
  onWorkflowStepsChange?: (workflowId: string) => void;
  /** Whether the listener is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Hook that listens to StepChangedEvent from Tauri and triggers cache invalidation.
 * Batches rapid events using debouncing to avoid excessive refetches.
 *
 * When a step change event arrives:
 * - If the changed step is currently selected, triggers onStepChange
 * - Triggers onWorkflowStepsChange to refresh the workflow's step list
 *
 * @param selectedStepId - The currently selected step ID
 * @param options - Configuration options for the listener
 */
export function useStepChangeListener(
  selectedStepId: string | null | undefined,
  options: UseStepChangeListenerOptions = {}
) {
  const { onStepChange, onWorkflowStepsChange, enabled = true } = options;
  const addToast = useToastStore((state) => state.addToast);

  // Track pending refetch requests for debouncing
  const pendingStepRefetch = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWorkflowRefetch = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingStepId = useRef<string | null>(null);
  const pendingWorkflowId = useRef<string | null>(null);

  // Stable callback refs to avoid effect re-runs
  const onStepChangeRef = useRef(onStepChange);
  const onWorkflowStepsChangeRef = useRef(onWorkflowStepsChange);
  onStepChangeRef.current = onStepChange;
  onWorkflowStepsChangeRef.current = onWorkflowStepsChange;

  const handleStepChanged = useCallback(
    (event: { payload: StepChangedEvent }) => {
      const { step_id, workflow_id, change_type } = event.payload;

      // Log event for debugging
      console.debug(
        `[StepChangeListener] Received ${change_type} event for step ${step_id.slice(0, 6)}`
      );

      // Show toast notification
      const toastType = change_type === "Created" ? "success"
        : change_type === "Deleted" ? "error"
        : "info";
      addToast(getStepChangeMessage(change_type, step_id), toastType);

      // If the changed step is the selected step, refetch it
      if (step_id === selectedStepId && onStepChangeRef.current) {
        if (change_type === "Deleted") {
          // Immediate call for deletions to clear UI faster
          onStepChangeRef.current(step_id);
        } else {
          // Debounce updates to batch rapid changes
          pendingStepId.current = step_id;
          if (pendingStepRefetch.current) {
            clearTimeout(pendingStepRefetch.current);
          }
          pendingStepRefetch.current = setTimeout(() => {
            if (pendingStepId.current && onStepChangeRef.current) {
              onStepChangeRef.current(pendingStepId.current);
            }
            pendingStepRefetch.current = null;
            pendingStepId.current = null;
          }, DEBOUNCE_MS);
        }
      }

      // Always trigger workflow steps refresh to update the workflow's step list
      if (onWorkflowStepsChangeRef.current) {
        pendingWorkflowId.current = workflow_id;
        if (pendingWorkflowRefetch.current) {
          clearTimeout(pendingWorkflowRefetch.current);
        }
        pendingWorkflowRefetch.current = setTimeout(() => {
          if (pendingWorkflowId.current && onWorkflowStepsChangeRef.current) {
            onWorkflowStepsChangeRef.current(pendingWorkflowId.current);
          }
          pendingWorkflowRefetch.current = null;
          pendingWorkflowId.current = null;
        }, DEBOUNCE_MS);
      }
    },
    [selectedStepId, addToast]
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    // Subscribe to step change events
    const unlistenPromise = events.stepChangedEvent.listen(handleStepChanged);

    // Cleanup on unmount
    return () => {
      unlistenPromise.then((unlisten) => unlisten());

      // Clear any pending timeouts
      if (pendingStepRefetch.current) {
        clearTimeout(pendingStepRefetch.current);
      }
      if (pendingWorkflowRefetch.current) {
        clearTimeout(pendingWorkflowRefetch.current);
      }
    };
  }, [enabled, handleStepChanged]);
}
