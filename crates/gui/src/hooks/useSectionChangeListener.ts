import { useEffect, useCallback } from "react";
import {
  events,
  type SectionChangedEvent,
} from "../bindings";
import { updateTaskSectionsInQueryCache } from "../query";
import {
  getProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";
import { useRefreshTaskForRealtimeChange } from "./useRefreshTaskForRealtimeChange";

/** Options for the section change listener hook */
interface UseSectionChangeListenerOptions {
  /** Whether the listener is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Hook that listens to SectionChangedEvent from Tauri and updates the
 * task's cached sections in TanStack Query when section payloads arrive.
 * Section payloads do not include a stable section id, and delete events carry
 * no section body, so every section event also refreshes the full task in the
 * background to reconcile ordering, refs, deletes, and task metadata.
 *
 * @param options - Configuration options for the listener
 */
export function useSectionChangeListener(
  options: UseSectionChangeListenerOptions = {}
) {
  const { enabled = true } = options;
  const projectScopeGeneration = useProjectScopeGeneration();
  const fetchAndReconcileTask =
    useRefreshTaskForRealtimeChange("SectionChangeListener");

  const handleSectionChanged = useCallback(
    (event: { payload: SectionChangedEvent }) => {
      if (projectScopeGeneration !== getProjectScopeGeneration()) return;

      const { task_id, change_type, section } = event.payload;

      console.debug(
        `[SectionChangeListener] Received ${change_type} event for task ${task_id.slice(0, 6)}`
      );

      if (section) {
        updateTaskSectionsInQueryCache(
          task_id,
          section,
          change_type === "Deleted" ? "remove" : "upsert",
          projectScopeGeneration
        );
      }

      void fetchAndReconcileTask(task_id);
    },
    [fetchAndReconcileTask, projectScopeGeneration]
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const unlistenPromise =
      events.sectionChangedEvent.listen(handleSectionChanged);

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [enabled, handleSectionChanged]);
}
