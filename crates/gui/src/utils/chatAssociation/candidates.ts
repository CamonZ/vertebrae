import type { AssociationEntity, Step, Task } from "../../bindings";
import { queryClient } from "../../query/queryClient";
import { queryKeys } from "../../query/queryKeys";
import { cachedTasksById } from "../../query/cachedTasks";
import { getProjectScopeGeneration } from "../../stores/projectScopedStores";

/** Use existing cached entities only. Reading candidates never starts a query. */
export function cachedAssociationCandidates(
  generation: number
): AssociationEntity[] {
  if (generation !== getProjectScopeGeneration()) return [];

  const tasks = cachedTasksById(generation);

  return [...tasks.values()]
    .filter((task) => isEligibleEntity(task, generation))
    .map((task) => ({
      id: task.id,
      title: task.title.slice(0, 160),
      level: task.level,
    }));
}

function isEligibleEntity(
  task: Task,
  generation: number
): task is Task & { level: AssociationEntity["level"] } {
  if (!task.level || task.archived || task.completed_at) return false;

  const step = task.current_step_id
    ? queryClient.getQueryData<Step>(
        queryKeys.steps.byId(generation, task.current_step_id)
      )
    : undefined;

  return (step?.step_type ?? task.step_type) !== "finish";
}
