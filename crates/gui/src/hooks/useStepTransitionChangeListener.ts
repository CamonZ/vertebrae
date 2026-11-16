import { useEffect, useCallback } from "react";
import { events, type StepTransitionChangedEvent } from "../bindings";
import { applyStepTransitionToQueryCache } from "../query";
import {
  getProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";

/** Options for the step transition change listener hook */
interface UseStepTransitionChangeListenerOptions {
  /** Called after the per-step cache is updated for a transition change */
  onStepTransitionChange?: (event: StepTransitionChangedEvent) => void;
  /** Whether the listener is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Hook that listens to StepTransitionChangedEvent from Tauri and applies the
 * edge to the source step's `steps.byId` entry (`transitions_to` and
 * `transition_sessions`), then notifies the optional consumer.
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

      applyStepTransitionToQueryCache(event.payload, projectScopeGeneration);

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
