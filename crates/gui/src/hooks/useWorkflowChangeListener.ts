import { useEffect, useCallback } from "react";
import {
  events,
  type WorkflowChangedEvent,
  type WorkflowChangeType,
} from "../bindings";
import { useToastStore } from "../stores";
import {
  getProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";
import {
  removeWorkflowFromQueryCache,
  upsertWorkflowInQueryCache,
} from "../query";

/** Get toast message for workflow change type */
function getWorkflowChangeMessage(
  changeType: WorkflowChangeType,
  workflowId: string
): string {
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
  }
}

/** Options for the workflow change listener hook */
interface UseWorkflowChangeListenerOptions {
  /** Whether the listener is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Hook that listens to WorkflowChangedEvent from Tauri and applies entity data
 * directly to the TanStack Query cache. No REST refetch is needed since WS payloads
 * carry the full entity.
 *
 * @param options - Configuration options for the listener
 */
export function useWorkflowChangeListener(
  options: UseWorkflowChangeListenerOptions = {}
) {
  const { enabled = true } = options;
  const addToast = useToastStore((state) => state.addToast);
  const projectScopeGeneration = useProjectScopeGeneration();

  const handleWorkflowChanged = useCallback(
    (event: { payload: WorkflowChangedEvent }) => {
      if (projectScopeGeneration !== getProjectScopeGeneration()) return;

      const { workflow_id, change_type, workflow } = event.payload;

      console.debug(
        `[WorkflowChangeListener] Received ${change_type} event for workflow ${workflow_id.slice(0, 6)}`
      );

      const toastType =
        change_type === "Created"
          ? "success"
          : change_type === "Deleted"
            ? "error"
            : "info";
      addToast(getWorkflowChangeMessage(change_type, workflow_id), toastType);

      if (change_type === "Deleted") {
        removeWorkflowFromQueryCache(workflow_id, projectScopeGeneration);
      } else if (workflow) {
        upsertWorkflowInQueryCache(workflow, projectScopeGeneration);
      }
    },
    [addToast, projectScopeGeneration]
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const unlistenPromise = events.workflowChangedEvent.listen(
      handleWorkflowChanged
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [enabled, handleWorkflowChanged]);
}
