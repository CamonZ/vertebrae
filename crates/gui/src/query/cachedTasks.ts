import type { Task } from "../bindings";
import { queryClient } from "./queryClient";
import { queryKeys } from "./queryKeys";

/**
 * Every task already in the cache for this project generation, by id. A
 * detail entry wins over a list entry. Reading this never starts a query.
 */
export function cachedTasksById(generation: number): Map<string, Task> {
  const tasks = new Map<string, Task>();
  for (const [, list] of queryClient.getQueriesData<Task[]>({
    queryKey: queryKeys.tasks.lists(generation),
  }))
    for (const task of list ?? []) tasks.set(task.id, task);
  for (const [, task] of queryClient.getQueriesData<Task>({
    queryKey: queryKeys.tasks.details(generation),
  }))
    if (task) tasks.set(task.id, task);
  return tasks;
}
