import { useCallback, useEffect } from "react";
import {
  events,
  type WorkflowTransition,
  type WorkflowTransitionChangedEvent,
} from "../bindings";
import {
  queryClient,
  queryKeys,
  removeWorkflowTransitionFromQueryCache,
  upsertWorkflowTransitionInQueryCache,
} from "../query";
import { useToastStore } from "../stores";
import {
  getProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";

function workflowName(generation: number, workflowId: string): string | null {
  const workflows = queryClient.getQueryData<
    Array<{ id: string; name: string }>
  >(queryKeys.workflows.list(generation));
  return (
    workflows?.find((workflow) => workflow.id === workflowId)?.name ?? null
  );
}

function transitionFromEvent(
  event: WorkflowTransitionChangedEvent,
  generation: number
): WorkflowTransition | null {
  if (!event.from_workflow_id || !event.to_workflow_id) return null;
  return {
    id: event.transition_id,
    from_workflow_id: event.from_workflow_id,
    from_workflow_name:
      workflowName(generation, event.from_workflow_id) ??
      event.from_workflow_id,
    to_workflow_id: event.to_workflow_id,
    to_workflow_name:
      workflowName(generation, event.to_workflow_id) ?? event.to_workflow_id,
    label: event.label ?? "",
    target_step_id: event.target_step_id,
  };
}

export function useWorkflowTransitionChangeListener({
  enabled = true,
}: { enabled?: boolean } = {}) {
  const addToast = useToastStore((state) => state.addToast);
  const generation = useProjectScopeGeneration();

  const handleChanged = useCallback(
    (event: { payload: WorkflowTransitionChangedEvent }) => {
      // The listener captures the project generation at subscription time. A
      // delayed event from the previous project must not touch the new cache.
      if (generation !== getProjectScopeGeneration()) return;
      const payload = event.payload;
      addToast(
        payload.change_type === "Created"
          ? `Workflow transition ${payload.transition_id.slice(0, 6)} created`
          : `Workflow transition ${payload.transition_id.slice(0, 6)} deleted`,
        payload.change_type === "Created" ? "success" : "error"
      );

      if (payload.change_type === "Deleted") {
        removeWorkflowTransitionFromQueryCache(
          payload.transition_id,
          generation
        );
        return;
      }
      const transition = transitionFromEvent(payload, generation);
      if (transition)
        upsertWorkflowTransitionInQueryCache(transition, generation);
    },
    [addToast, generation]
  );

  useEffect(() => {
    if (!enabled) return;
    const unlistenPromise =
      events.workflowTransitionChangedEvent.listen(handleChanged);
    return () => {
      void unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [enabled, handleChanged]);
}
