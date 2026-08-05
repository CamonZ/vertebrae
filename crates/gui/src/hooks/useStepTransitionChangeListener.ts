import { useEffect, useCallback } from "react";
import { events, type StepTransitionChangedEvent, type StepTransitionChangeType } from "../bindings";
import { useNotificationStore } from "../stores";
import {
  getProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";

/** Get toast message for step transition change type */
function getTransitionChangeMessage(changeType: StepTransitionChangeType, transitionId: string): string {
  const shortId = transitionId.slice(0, 6);
  switch (changeType) {
    case "Created":
      return `Step transition ${shortId} created`;
    case "Deleted":
      return `Step transition ${shortId} deleted`;
  }
}

/** Options for the step transition change listener hook */
interface UseStepTransitionChangeListenerOptions {
  /** Called when a step transition is created or deleted */
  onStepTransitionChange?: (event: StepTransitionChangedEvent) => void;
  /** Whether the listener is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Hook that listens to StepTransitionChangedEvent from Tauri.
 * Step transitions define how steps connect to each other in a workflow.
 * This hook notifies consumers so they can update transition-related state.
 *
 * @param options - Configuration options for the listener
 */
export function useStepTransitionChangeListener(
  options: UseStepTransitionChangeListenerOptions = {}
) {
  const { onStepTransitionChange, enabled = true } = options;
  const addNotification = useNotificationStore(
    (state) => state.addNotification
  );
  const projectScopeGeneration = useProjectScopeGeneration();

  const handleStepTransitionChanged = useCallback(
    (event: { payload: StepTransitionChangedEvent }) => {
      if (projectScopeGeneration !== getProjectScopeGeneration()) return;

      const { transition_id, change_type } = event.payload;

      console.debug(
        `[StepTransitionChangeListener] Received ${change_type} event for transition ${transition_id.slice(0, 6)}`
      );

      const toastType = change_type === "Created" ? "success" : "error";
      addNotification({
        message: getTransitionChangeMessage(change_type, transition_id),
        type: toastType,
        entity: "step",
        entityId: transition_id,
      });

      if (onStepTransitionChange) {
        onStepTransitionChange(event.payload);
      }
    },
    [addNotification, onStepTransitionChange, projectScopeGeneration]
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const unlistenPromise = events.stepTransitionChangedEvent.listen(
      handleStepTransitionChanged
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [enabled, handleStepTransitionChanged]);
}
