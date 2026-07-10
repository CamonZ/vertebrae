import { useQuery } from "@tanstack/react-query";
import { commands, type Task } from "../bindings";
import { queryKeys, unwrapCommand } from "../query";
import { useProjectScopeGeneration } from "../stores/projectScopedStores";
import { resolveTaskLocation, type TaskLocation } from "../utils/taskLocation";

/** Resolve a task's render-time location from the active project's caches. */
export function useTaskLocation(task: Task | null | undefined): TaskLocation {
  const generation = useProjectScopeGeneration();
  const stepId = task?.current_step_id ?? "";
  const workflowId = task?.workflow_id ?? "";
  const stepQuery = useQuery({
    queryKey: queryKeys.steps.byId(generation, stepId),
    queryFn: () => unwrapCommand(commands.getStep(stepId)),
    enabled: Boolean(stepId),
  });
  const workflowsQuery = useQuery({
    queryKey: queryKeys.workflows.list(generation),
    queryFn: () => unwrapCommand(commands.listWorkflows()),
    enabled: Boolean(stepId || workflowId),
  });

  const resolvedWorkflowId = task?.workflow_id ?? stepQuery.data?.workflow_id;
  const workflow = workflowsQuery.data?.find(
    (candidate) => candidate.id === resolvedWorkflowId
  );
  return resolveTaskLocation(
    task ?? { workflow_id: null, current_step_id: null },
    stepQuery.data,
    workflow
  );
}
