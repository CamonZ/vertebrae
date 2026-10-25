import type { AssociationTicket, Step, Task } from "../../bindings";
import { queryClient } from "../../query/queryClient";
import { queryKeys } from "../../query/queryKeys";
import { getProjectScopeGeneration } from "../../stores/projectScopedStores";

/** Use existing cached tickets only. Reading candidates never starts a query. */
export function cachedAssociationCandidates(
  generation: number
): AssociationTicket[] {
  if (generation !== getProjectScopeGeneration()) return [];

  const tasks = new Map<string, Task>();
  const lists = queryClient.getQueriesData<Task[]>({
    queryKey: queryKeys.tasks.lists(generation),
  });
  const details = queryClient.getQueriesData<Task>({
    queryKey: queryKeys.tasks.details(generation),
  });

  for (const [, list] of lists) {
    for (const task of list ?? []) {
      tasks.set(task.id, task);
    }
  }
  for (const [, task] of details) {
    if (task) {
      tasks.set(task.id, task);
    }
  }

  return [...tasks.values()]
    .filter((task) => isEligibleTicket(task, generation))
    .map((task) => ({
      id: task.id,
      title: task.title.slice(0, 160),
    }));
}

function isEligibleTicket(task: Task, generation: number): boolean {
  if (task.level !== "ticket" || task.archived || task.completed_at)
    return false;

  const step = task.current_step_id
    ? queryClient.getQueryData<Step>(
        queryKeys.steps.byId(generation, task.current_step_id)
      )
    : undefined;

  return (step?.step_type ?? task.step_type) !== "finish";
}
