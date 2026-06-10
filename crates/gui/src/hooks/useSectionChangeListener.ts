import { useEffect, useCallback } from "react";
import {
  events,
  type SectionChangedEvent,
  type SectionChangeType,
} from "../bindings";
import { updateTaskSectionsInQueryCache } from "../query";
import { useToastStore } from "../stores";
import {
  getProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";

/** Get toast message for section change type */
function getSectionChangeMessage(
  changeType: SectionChangeType,
  taskId: string
): string {
  const shortId = taskId.slice(0, 6);
  switch (changeType) {
    case "Created":
      return `Section added to task ${shortId}`;
    case "Updated":
      return `Section updated on task ${shortId}`;
    case "Deleted":
      return `Section removed from task ${shortId}`;
  }
}

/** Options for the section change listener hook */
interface UseSectionChangeListenerOptions {
  /** Whether the listener is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Hook that listens to SectionChangedEvent from Tauri and updates the
 * task's cached sections in TanStack Query when section payloads arrive.
 *
 * @param options - Configuration options for the listener
 */
export function useSectionChangeListener(
  options: UseSectionChangeListenerOptions = {}
) {
  const { enabled = true } = options;
  const addToast = useToastStore((state) => state.addToast);
  const projectScopeGeneration = useProjectScopeGeneration();

  const handleSectionChanged = useCallback(
    (event: { payload: SectionChangedEvent }) => {
      if (projectScopeGeneration !== getProjectScopeGeneration()) return;

      const { task_id, change_type, section } = event.payload;

      console.debug(
        `[SectionChangeListener] Received ${change_type} event for task ${task_id.slice(0, 6)}`
      );

      const toastType =
        change_type === "Created"
          ? "success"
          : change_type === "Deleted"
            ? "error"
            : "info";
      addToast(getSectionChangeMessage(change_type, task_id), toastType);

      if (section) {
        updateTaskSectionsInQueryCache(
          task_id,
          section,
          change_type === "Deleted" ? "remove" : "upsert",
          projectScopeGeneration
        );
      }
    },
    [addToast, projectScopeGeneration]
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
