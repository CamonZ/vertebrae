import { useEffect, useCallback } from "react";
import { events, type SectionChangedEvent, type SectionChangeType } from "../bindings";
import { useTaskStore, useToastStore } from "../stores";

/** Get toast message for section change type */
function getSectionChangeMessage(changeType: SectionChangeType, taskId: string): string {
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
 * selected task's sections directly in the task store when the section
 * belongs to the currently selected task.
 *
 * @param options - Configuration options for the listener
 */
export function useSectionChangeListener(
  options: UseSectionChangeListenerOptions = {}
) {
  const { enabled = true } = options;
  const addToast = useToastStore((state) => state.addToast);

  const handleSectionChanged = useCallback(
    (event: { payload: SectionChangedEvent }) => {
      const { task_id, change_type, section } = event.payload;

      console.debug(
        `[SectionChangeListener] Received ${change_type} event for task ${task_id.slice(0, 6)}`
      );

      const toastType = change_type === "Created" ? "success"
        : change_type === "Deleted" ? "error"
        : "info";
      addToast(getSectionChangeMessage(change_type, task_id), toastType);

      // Read current state inside the callback to avoid stale closures
      // and prevent listener churn from selectedTask changes
      const { selectedTaskId, selectedTask, selectTask } = useTaskStore.getState();

      if (task_id !== selectedTaskId || !selectedTask) {
        return;
      }

      const existingSections = selectedTask.sections ?? [];

      if (change_type === "Deleted") {
        if (section) {
          const updatedSections = existingSections.filter(
            (s) => !(s.type === section.type && s.order === section.order)
          );
          selectTask(selectedTaskId, { ...selectedTask, sections: updatedSections });
        }
      } else if (section) {
        const index = existingSections.findIndex(
          (s) => s.type === section.type && s.order === section.order
        );
        if (index >= 0) {
          const updatedSections = [...existingSections];
          updatedSections[index] = section;
          selectTask(selectedTaskId, { ...selectedTask, sections: updatedSections });
        } else {
          selectTask(selectedTaskId, {
            ...selectedTask,
            sections: [...existingSections, section],
          });
        }
      }
    },
    [addToast]
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const unlistenPromise = events.sectionChangedEvent.listen(handleSectionChanged);

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [enabled, handleSectionChanged]);
}
