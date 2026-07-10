import { commands, type Task, type TaskRun } from "../bindings";
import { unwrapCommand } from "./commandResult";
import { queryClient } from "./queryClient";
import { queryKeys } from "./queryKeys";
import { mergeFetchedTaskRuns } from "./serverCache";

export function taskRunsQueryOptions(generation: number, taskId: string) {
  const queryKey = queryKeys.taskRuns.byTask(generation, taskId);
  return {
    queryKey,
    queryFn: async (): Promise<TaskRun[]> => {
      const runsAtFetchStart = queryClient.getQueryData<TaskRun[]>(queryKey);
      const fetchedRuns = await unwrapCommand(commands.getTaskRuns(taskId));
      const currentRuns = queryClient.getQueryData<TaskRun[]>(queryKey);
      return mergeFetchedTaskRuns(fetchedRuns, currentRuns, runsAtFetchStart);
    },
  };
}

/**
 * The bulk task queries already carry the current active run. Seed an absent
 * per-task cache entry from that snapshot so list surfaces can read the query
 * cache without fetching every task's complete run history. Never overwrite a
 * cache entry: it may contain a newer websocket update or loaded history.
 */
export function hydrateActiveTaskRunsFromTasks(
  tasks: readonly Pick<Task, "run_controls">[],
  generation: number
) {
  for (const task of tasks) {
    const activeRun = task.run_controls?.active_run;
    if (!activeRun) continue;

    const queryKey = queryKeys.taskRuns.byTask(generation, activeRun.task_id);
    const existingRuns = queryClient.getQueryData<TaskRun[]>(queryKey);
    if (existingRuns !== undefined) continue;

    queryClient.setQueryData<TaskRun[]>(queryKey, [activeRun]);
  }
}
