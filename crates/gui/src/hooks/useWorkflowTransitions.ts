import { useQuery } from "@tanstack/react-query";
import type { WorkflowTransition } from "../bindings";
import { commands } from "../bindings";
import { errorMessage, queryKeys, unwrapCommand } from "../query";
import { useProjectScopeGeneration } from "../stores/projectScopedStores";
import { useWorkflows } from "./useWorkflows";

export function useWorkflowTransitions() {
  const generation = useProjectScopeGeneration();
  const query = useQuery({
    queryKey: queryKeys.workflowTransitions.list(generation),
    queryFn: () => unwrapCommand(commands.listWorkflowTransitions()),
  });

  // Workflow names are canonical Workflow query data. The transition payload's
  // denormalized names are retained only for transport compatibility.
  const { workflows, isLoading: workflowsLoading, error: workflowsError } =
    useWorkflows();
  const workflowNames = new Map(
    workflows.map((workflow) => [workflow.id, workflow.name])
  );
  const transitions = (query.data ?? []).map(
    (transition): WorkflowTransition => ({
      ...transition,
      from_workflow_name:
        workflowNames.get(transition.from_workflow_id) ??
        transition.from_workflow_id,
      to_workflow_name:
        workflowNames.get(transition.to_workflow_id) ??
        transition.to_workflow_id,
    })
  );

  return {
    transitions,
    isLoading: query.isLoading || workflowsLoading,
    error: query.error ? errorMessage(query.error) : workflowsError,
    refetch: () => {
      void query.refetch();
    },
  };
}
