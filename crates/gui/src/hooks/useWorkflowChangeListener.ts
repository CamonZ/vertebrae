import { useEffect, useRef, useCallback } from "react";
import { events, type WorkflowChangedEvent, type WorkflowChangeType } from "../bindings";
import { useWorkflowStore, useToastStore } from "../stores";

/** Debounce delay in milliseconds for batching rapid events */
const DEBOUNCE_MS = 100;

/** Get toast message for workflow change type */
function getWorkflowChangeMessage(changeType: WorkflowChangeType, workflowId: string): string {
  const shortId = workflowId.slice(0, 6);
  switch (changeType) {
    case "Created":
      return `Workflow ${shortId} created`;
    case "Updated":
      return `Workflow ${shortId} updated`;
    case "Deleted":
      return `Workflow ${shortId} deleted`;
    case "TaskAssigned":
      return `Task assigned to workflow ${shortId}`;
    case "TaskUnassigned":
      return `Task unassigned from workflow`;
    case "StepAdvanced":
      return `Task advanced in workflow ${shortId}`;
    case "StepRetreated":
      return `Task retreated in workflow ${shortId}`;
    case "TaskRejected":
      return `Task rejected from workflow ${shortId}`;
  }
}

/** Options for the workflow change listener hook */
interface UseWorkflowChangeListenerOptions {
  /** Called when workflow list should be refetched */
  onWorkflowListChange?: () => void;
  /** Called when a specific workflow should be refetched */
  onWorkflowChange?: (workflowId: string) => void;
  /** Whether the listener is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Hook that listens to WorkflowChangedEvent from Tauri and triggers cache invalidation.
 * Batches rapid events using debouncing to avoid excessive refetches.
 *
 * When a workflow change event arrives:
 * - If the changed workflow is the currently selected workflow, triggers onWorkflowChange
 * - Always triggers onWorkflowListChange to refresh the workflow list
 *
 * @param options - Configuration options for the listener
 */
export function useWorkflowChangeListener(
  options: UseWorkflowChangeListenerOptions = {}
) {
  const { onWorkflowListChange, onWorkflowChange, enabled = true } = options;
  const { currentWorkflow } = useWorkflowStore();
  const addToast = useToastStore((state) => state.addToast);

  // Get the current workflow ID for comparison
  const currentWorkflowId = currentWorkflow?.workflow?.id ?? null;

  // Track pending refetch requests for debouncing
  const pendingListRefetch = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWorkflowRefetch = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const pendingWorkflowId = useRef<string | null>(null);

  // Stable callback refs to avoid effect re-runs
  const onWorkflowListChangeRef = useRef(onWorkflowListChange);
  const onWorkflowChangeRef = useRef(onWorkflowChange);
  onWorkflowListChangeRef.current = onWorkflowListChange;
  onWorkflowChangeRef.current = onWorkflowChange;

  const handleWorkflowChanged = useCallback(
    (event: { payload: WorkflowChangedEvent }) => {
      const { workflow_id, change_type } = event.payload;

      // Log event for debugging (can be removed in production)
      console.debug(
        `[WorkflowChangeListener] Received ${change_type} event for workflow ${workflow_id.slice(0, 6)}`
      );

      // Show toast notification with appropriate color
      // Created: green (success), Updated: blue (info), Deleted: red (error)
      const toastType = change_type === "Created" ? "success"
        : change_type === "Deleted" ? "error"
        : "info";
      addToast(getWorkflowChangeMessage(change_type, workflow_id), toastType);

      // Debounce workflow list refetch
      if (onWorkflowListChangeRef.current) {
        if (pendingListRefetch.current) {
          clearTimeout(pendingListRefetch.current);
        }
        pendingListRefetch.current = setTimeout(() => {
          onWorkflowListChangeRef.current?.();
          pendingListRefetch.current = null;
        }, DEBOUNCE_MS);
      }

      // If the changed workflow is the current workflow, refetch it
      if (workflow_id === currentWorkflowId && onWorkflowChangeRef.current) {
        // For deleted workflows, the refetch will return not found - that's handled by useWorkflow
        if (change_type === "Deleted") {
          // Immediate call for deletions to clear UI faster
          onWorkflowChangeRef.current(workflow_id);
        } else {
          // Debounce updates to batch rapid changes
          pendingWorkflowId.current = workflow_id;
          if (pendingWorkflowRefetch.current) {
            clearTimeout(pendingWorkflowRefetch.current);
          }
          pendingWorkflowRefetch.current = setTimeout(() => {
            if (pendingWorkflowId.current && onWorkflowChangeRef.current) {
              onWorkflowChangeRef.current(pendingWorkflowId.current);
            }
            pendingWorkflowRefetch.current = null;
            pendingWorkflowId.current = null;
          }, DEBOUNCE_MS);
        }
      }
    },
    [currentWorkflowId, addToast]
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    // Subscribe to workflow change events
    const unlistenPromise =
      events.workflowChangedEvent.listen(handleWorkflowChanged);

    // Cleanup on unmount
    return () => {
      unlistenPromise.then((unlisten) => unlisten());

      // Clear any pending timeouts
      if (pendingListRefetch.current) {
        clearTimeout(pendingListRefetch.current);
      }
      if (pendingWorkflowRefetch.current) {
        clearTimeout(pendingWorkflowRefetch.current);
      }
    };
  }, [enabled, handleWorkflowChanged]);
}
