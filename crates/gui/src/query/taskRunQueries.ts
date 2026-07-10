import { commands, type TaskRun } from "../bindings";
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
