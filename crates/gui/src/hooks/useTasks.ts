import { useQuery } from "@tanstack/react-query";
import { commands, type Task, type TaskFilterOptions } from "../bindings";
import { useProjectScopeGeneration } from "../stores/projectScopedStores";
import { errorMessage, queryClient, queryKeys, unwrapCommand } from "../query";
import { mergeTask, taskMatchesFilter } from "../stores/taskStore";

// Stable fallback for renders where the query has no data yet (loading or
// error). A fresh `[]` per render changes identity every time and re-fires
// any effect/memo that depends on `tasks`, which can loop render → effect →
// state update → render.
const NO_TASKS: Task[] = [];

function updatedAtMs(task: Task): number | null {
  if (!task.updated_at) return null;
  const ms = Date.parse(task.updated_at);
  return Number.isNaN(ms) ? null : ms;
}

function preferCurrentTaskWhenNewer(fetched: Task, current: Task): Task {
  const fetchedMs = updatedAtMs(fetched);
  const currentMs = updatedAtMs(current);
  if (currentMs === null || fetchedMs === null || currentMs >= fetchedMs) {
    return mergeTask(fetched, current);
  }
  return mergeTask(current, fetched);
}

/**
 * Hook for fetching and managing the task list.
 *
 * TanStack Query owns the server-state cache for task list data.
 */
export function useTasks(filter?: TaskFilterOptions) {
  const activeFilter = filter ?? null;
  const projectScopeGeneration = useProjectScopeGeneration();
  const queryKey = queryKeys.tasks.list(projectScopeGeneration, activeFilter);

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const tasksAtFetchStart = new Map(
        (queryClient.getQueryData<Task[]>(queryKey) ?? []).map((task) => [
          task.id,
          task,
        ])
      );
      const detailTasksAtFetchStart = new Map(
        queryClient
          .getQueriesData<Task>({
            queryKey: queryKeys.tasks.details(projectScopeGeneration),
          })
          .map(([, task]) => task)
          .filter((task): task is Task => Boolean(task))
          .map((task) => [task.id, task])
      );
      const tasks = await unwrapCommand(commands.listTasks(activeFilter));

      // Preserve only tasks newly inserted while this request was in flight.
      // Pre-existing query entries can belong to a previously selected
      // project and must not be re-added after the scoped fetch completes.
      const currentQueryTasks =
        queryClient.getQueryData<Task[]>(queryKey) ?? [];
      const currentDetailTasks = queryClient
        .getQueriesData<Task>({
          queryKey: queryKeys.tasks.details(projectScopeGeneration),
        })
        .map(([, task]) => task)
        .filter((task): task is Task => Boolean(task));
      const fetchedIds = new Set(tasks.map((task) => task.id));
      const currentTasksById = new Map(
        currentQueryTasks.map((task) => [task.id, task])
      );
      const currentDetailTasksById = new Map(
        currentDetailTasks.map((task) => [task.id, task])
      );
      const reconciledFetchedTasks = tasks.map((task) => {
        const currentTask =
          currentTasksById.get(task.id) ?? currentDetailTasksById.get(task.id);
        const taskAtFetchStart =
          tasksAtFetchStart.get(task.id) ?? detailTasksAtFetchStart.get(task.id);
        if (!currentTask || currentTask === taskAtFetchStart) return task;
        return preferCurrentTaskWhenNewer(task, currentTask);
      });
      const upsertedDuringFetch = currentQueryTasks.filter(
        (task) => !fetchedIds.has(task.id) && !tasksAtFetchStart.has(task.id)
      );
      const upsertedDuringFetchIds = new Set(
        upsertedDuringFetch.map((task) => task.id)
      );
      const detailUpsertsDuringFetch = currentDetailTasks.filter(
        (task) =>
          !fetchedIds.has(task.id) &&
          !upsertedDuringFetchIds.has(task.id) &&
          !tasksAtFetchStart.has(task.id) &&
          !detailTasksAtFetchStart.has(task.id) &&
          taskMatchesFilter(task, activeFilter)
      );

      return [
        ...reconciledFetchedTasks,
        ...upsertedDuringFetch,
        ...detailUpsertsDuringFetch,
      ];
    },
  });

  return {
    tasks: query.data ?? NO_TASKS,
    isLoading: query.isLoading,
    error: query.error ? errorMessage(query.error) : null,
    refetch: () => {
      void query.refetch();
    },
  };
}
