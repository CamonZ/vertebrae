import { useEffect, useCallback } from "react";
import { events, type StepTransitionChangedEvent } from "../bindings";
import {
  getProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";

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
  const projectScopeGeneration = useProjectScopeGeneration();

  const handleStepTransitionChanged = useCallback(
    (event: { payload: StepTransitionChangedEvent }) => {
      if (projectScopeGeneration !== getProjectScopeGeneration()) return;

      const { transition_id, change_type } = event.payload;

      console.debug(
        `[StepTransitionChangeListener] Received ${change_type} event for transition ${transition_id.slice(0, 6)}`
      );

      if (onStepTransitionChange) {
        onStepTransitionChange(event.payload);
      }
    },
    [onStepTransitionChange, projectScopeGeneration]
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
