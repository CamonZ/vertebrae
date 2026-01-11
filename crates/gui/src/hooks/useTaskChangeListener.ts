import { useEffect, useRef, useCallback } from "react";
import { events, type TaskChangedEvent } from "../bindings";
import { useTaskStore } from "../stores";

/** Debounce delay in milliseconds for batching rapid events */
const DEBOUNCE_MS = 100;

/** Options for the task change listener hook */
interface UseTaskChangeListenerOptions {
  /** Called when task list should be refetched */
  onTaskListChange?: () => void;
  /** Called when a specific task should be refetched */
  onTaskChange?: (taskId: string) => void;
  /** Whether the listener is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Hook that listens to TaskChangedEvent from Tauri and triggers cache invalidation.
 * Batches rapid events using debouncing to avoid excessive refetches.
 *
 * When a task change event arrives:
 * - If the changed task is the currently selected task, triggers onTaskChange
 * - Always triggers onTaskListChange to refresh the task list
 *
 * @param options - Configuration options for the listener
 */
export function useTaskChangeListener(options: UseTaskChangeListenerOptions = {}) {
  const { onTaskListChange, onTaskChange, enabled = true } = options;
  const { selectedTaskId } = useTaskStore();

  // Track pending refetch requests for debouncing
  const pendingListRefetch = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTaskRefetch = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTaskId = useRef<string | null>(null);

  // Stable callback refs to avoid effect re-runs
  const onTaskListChangeRef = useRef(onTaskListChange);
  const onTaskChangeRef = useRef(onTaskChange);
  onTaskListChangeRef.current = onTaskListChange;
  onTaskChangeRef.current = onTaskChange;

  const handleTaskChanged = useCallback(
    (event: { payload: TaskChangedEvent }) => {
      const { task_id, change_type } = event.payload;

      // Log event for debugging (can be removed in production)
      console.debug(
        `[TaskChangeListener] Received ${change_type} event for task ${task_id.slice(0, 6)}`
      );

      // Debounce task list refetch
      if (onTaskListChangeRef.current) {
        if (pendingListRefetch.current) {
          clearTimeout(pendingListRefetch.current);
        }
        pendingListRefetch.current = setTimeout(() => {
          onTaskListChangeRef.current?.();
          pendingListRefetch.current = null;
        }, DEBOUNCE_MS);
      }

      // If the changed task is the selected task, refetch it
      if (task_id === selectedTaskId && onTaskChangeRef.current) {
        // For deleted tasks, the refetch will return not found - that's handled by useTask
        if (change_type === "Deleted") {
          // Immediate call for deletions to clear UI faster
          onTaskChangeRef.current(task_id);
        } else {
          // Debounce updates to batch rapid changes
          pendingTaskId.current = task_id;
          if (pendingTaskRefetch.current) {
            clearTimeout(pendingTaskRefetch.current);
          }
          pendingTaskRefetch.current = setTimeout(() => {
            if (pendingTaskId.current && onTaskChangeRef.current) {
              onTaskChangeRef.current(pendingTaskId.current);
            }
            pendingTaskRefetch.current = null;
            pendingTaskId.current = null;
          }, DEBOUNCE_MS);
        }
      }
    },
    [selectedTaskId]
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    // Subscribe to task change events
    const unlistenPromise = events.taskChangedEvent.listen(handleTaskChanged);

    // Cleanup on unmount
    return () => {
      unlistenPromise.then((unlisten) => unlisten());

      // Clear any pending timeouts
      if (pendingListRefetch.current) {
        clearTimeout(pendingListRefetch.current);
      }
      if (pendingTaskRefetch.current) {
        clearTimeout(pendingTaskRefetch.current);
      }
    };
  }, [enabled, handleTaskChanged]);
}
