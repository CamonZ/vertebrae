import type {
  Task,
  TaskFilterOptions,
  TaskRunControls,
  Workflow,
  WorkflowWithTasks,
} from "../bindings";
import {
  mergeTask,
  taskMatchesFilter,
  taskRunControlsEqual,
} from "../stores/taskStore";
import { getProjectScopeGeneration } from "../stores/projectScopedStores";
import { queryClient } from "./queryClient";
import { queryKeys } from "./queryKeys";

type TaskListKey = ReturnType<typeof queryKeys.tasks.list>;
type WorkflowDetailKey = ReturnType<typeof queryKeys.workflows.detail>;

function taskListFilterFromKey(
  key: readonly unknown[]
): TaskFilterOptions | null {
  return (key as TaskListKey)[4] ?? null;
}

function reconcileTaskList(
  tasks: readonly Task[] | undefined,
  task: Task,
  filter: TaskFilterOptions | null
): Task[] | undefined {
  const current = tasks ?? [];
  const index = current.findIndex((item) => item.id === task.id);
  const mergedTask = index >= 0 ? mergeTask(current[index], task) : task;

  if (!taskMatchesFilter(mergedTask, filter)) {
    return index === -1
      ? current.slice()
      : current.filter((item) => item.id !== task.id);
  }

  if (index === -1) return [...current, mergedTask];

  const next = current.slice();
  next[index] = mergedTask;
  return next;
}

export function upsertTaskInQueryCache(
  task: Task,
  generation = getProjectScopeGeneration()
) {
  queryClient.setQueryData(queryKeys.tasks.detail(generation, task.id), task);

  const lists = queryClient.getQueriesData<Task[]>({
    queryKey: queryKeys.tasks.lists(generation),
  });
  for (const [key, tasks] of lists) {
    queryClient.setQueryData(
      key,
      reconcileTaskList(tasks, task, taskListFilterFromKey(key))
    );
  }
}

export function removeTaskFromQueryCache(
  taskId: string,
  generation = getProjectScopeGeneration()
) {
  queryClient.removeQueries({
    queryKey: queryKeys.tasks.detail(generation, taskId),
  });

  const lists = queryClient.getQueriesData<Task[]>({
    queryKey: queryKeys.tasks.lists(generation),
  });
  for (const [key, tasks] of lists) {
    queryClient.setQueryData(
      key,
      (tasks ?? []).filter((task) => task.id !== taskId)
    );
  }
}

export function replaceTaskRunControlsInQueryCache(
  taskId: string,
  runControls: TaskRunControls | null,
  generation = getProjectScopeGeneration()
) {
  const replaceControls = (task: Task): Task =>
    taskRunControlsEqual(task.run_controls, runControls)
      ? task
      : { ...task, run_controls: runControls };

  queryClient.setQueryData<Task | undefined>(
    queryKeys.tasks.detail(generation, taskId),
    (task) => (task ? replaceControls(task) : task)
  );

  const lists = queryClient.getQueriesData<Task[]>({
    queryKey: queryKeys.tasks.lists(generation),
  });
  for (const [key, tasks] of lists) {
    queryClient.setQueryData(
      key,
      (tasks ?? []).map((task) =>
        task.id === taskId ? replaceControls(task) : task
      )
    );
  }
}

export function upsertWorkflowInQueryCache(
  workflow: Workflow,
  generation = getProjectScopeGeneration()
) {
  queryClient.setQueryData<Workflow[] | undefined>(
    queryKeys.workflows.list(generation),
    (workflows) => {
      const current = workflows ?? [];
      const index = current.findIndex((item) => item.id === workflow.id);
      if (index === -1) return [...current, workflow];
      const next = current.slice();
      next[index] = workflow;
      return next;
    }
  );

  const details = queryClient.getQueriesData<WorkflowWithTasks>({
    queryKey: queryKeys.workflows.details(generation),
  });
  for (const [key, value] of details) {
    const detailKey = key as WorkflowDetailKey;
    if (detailKey[4] !== workflow.id || !value) continue;
    queryClient.setQueryData(key, { ...value, workflow });
  }
}

export function removeWorkflowFromQueryCache(
  workflowId: string,
  generation = getProjectScopeGeneration()
) {
  queryClient.removeQueries({
    queryKey: queryKeys.workflows.detail(generation, workflowId),
  });

  queryClient.setQueryData<Workflow[] | undefined>(
    queryKeys.workflows.list(generation),
    (workflows) =>
      (workflows ?? []).filter((workflow) => workflow.id !== workflowId)
  );
}
