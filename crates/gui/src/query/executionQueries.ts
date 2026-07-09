import { commands, type StepExecution } from "../bindings";
import { unwrapCommand } from "./commandResult";
import { queryClient } from "./queryClient";
import { queryKeys } from "./queryKeys";
import { mergeFetchedStepExecutions } from "./serverCache";

export function taskExecutionsQueryOptions(
  generation: number,
  taskId: string
) {
  const queryKey = queryKeys.executions.byTask(generation, taskId);

  return {
    queryKey,
    queryFn: async () => {
      const executionsAtFetchStart =
        queryClient.getQueryData<StepExecution[]>(queryKey);
      const fetchedExecutions = await unwrapCommand(
        commands.getTaskExecutions(taskId)
      );
      const currentExecutions =
        queryClient.getQueryData<StepExecution[]>(queryKey);
      return mergeFetchedStepExecutions(
        fetchedExecutions,
        currentExecutions,
        executionsAtFetchStart
      );
    },
  };
}
