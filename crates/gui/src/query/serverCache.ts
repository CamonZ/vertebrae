import type {
  Section,
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
} from "../utils/taskMerge";
import { getProjectScopeGeneration } from "../stores/projectScopedStores";
import { queryClient } from "./queryClient";
import { queryKeys } from "./queryKeys";

type TaskListKey = ReturnType<typeof queryKeys.tasks.list>;
type WorkflowDetailKey = ReturnType<typeof queryKeys.workflows.detail>;
const TASK_LIST_KEY_LENGTH = queryKeys.tasks.list(0, null).length;

function taskListFilterFromKey(
  key: readonly unknown[]
): TaskFilterOptions | null {
  if (key.length !== TASK_LIST_KEY_LENGTH || key[3] !== "list") {
    throw new Error(`Unexpected task list query key: ${JSON.stringify(key)}`);
  }
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
    return current.filter((item) => item.id !== task.id);
  }

  if (index === -1) return [...current, mergedTask];

  const next = current.slice();
  next[index] = mergedTask;
  return next;
}

function isRetiredFromReadyFeed(task: Task): boolean {
  return task.archived === true || Boolean(task.completed_at);
}

function shouldAppendToReadyFeed(task: Task): boolean {
  return (
    !isRetiredFromReadyFeed(task) &&
    (task.run_controls?.runnable === true ||
      task.run_controls?.active_run != null)
  );
}

function upsertReadyTask(task: Task, generation: number): void {
  queryClient.setQueryData<Task[] | undefined>(
    queryKeys.tasks.ready(generation),
    (tasks) => {
      if (!tasks) return tasks;
      const index = tasks.findIndex((item) => item.id === task.id);
      if (index === -1) {
        return shouldAppendToReadyFeed(task) ? [...tasks, task] : tasks;
      }
      const mergedTask = mergeTask(tasks[index], task);
      if (isRetiredFromReadyFeed(mergedTask)) {
        return tasks.filter((item) => item.id !== task.id);
      }
      const next = tasks.slice();
      next[index] = mergedTask;
      return next;
    }
  );
}

function mapReadyTasks(
  generation: number,
  mapTask: (task: Task) => Task
): void {
  queryClient.setQueryData<Task[] | undefined>(
    queryKeys.tasks.ready(generation),
    (tasks) => tasks?.map(mapTask)
  );
}

export function upsertTaskInQueryCache(
  task: Task,
  generation = getProjectScopeGeneration()
) {
  queryClient.setQueryData<Task | undefined>(
    queryKeys.tasks.detail(generation, task.id),
    (existing) => (existing ? mergeTask(existing, task) : task)
  );
  upsertReadyTask(task, generation);

  const lists = queryClient.getQueriesData<Task[]>({
    queryKey: queryKeys.tasks.lists(generation),
  });
  for (const [key] of lists) {
    const filter = taskListFilterFromKey(key);
    queryClient.setQueryData<Task[] | undefined>(key, (currentTasks) =>
      currentTasks === undefined
        ? undefined
        : reconcileTaskList(currentTasks, task, filter)
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
  for (const [key] of lists) {
    queryClient.setQueryData<Task[] | undefined>(key, (currentTasks) =>
      currentTasks?.filter((task) => task.id !== taskId)
    );
  }

  queryClient.setQueryData<Task[] | undefined>(
    queryKeys.tasks.ready(generation),
    (tasks) => tasks?.filter((task) => task.id !== taskId)
  );
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
  for (const [key] of lists) {
    queryClient.setQueryData<Task[] | undefined>(key, (currentTasks) =>
      currentTasks?.map((task) =>
        task.id === taskId ? replaceControls(task) : task
      )
    );
  }

  mapReadyTasks(generation, (task) =>
    task.id === taskId ? replaceControls(task) : task
  );
}

export function hasTaskInQueryCache(
  taskId: string,
  generation = getProjectScopeGeneration()
) {
  if (queryClient.getQueryData(queryKeys.tasks.detail(generation, taskId))) {
    return true;
  }

  const lists = queryClient.getQueriesData<Task[]>({
    queryKey: queryKeys.tasks.lists(generation),
  });

  if (
    lists.some(([, tasks]) => (tasks ?? []).some((task) => task.id === taskId))
  ) {
    return true;
  }

  const readyTasks = queryClient.getQueryData<Task[]>(
    queryKeys.tasks.ready(generation)
  );

  return (readyTasks ?? []).some((task) => task.id === taskId);
}

export function updateTaskSectionsInQueryCache(
  taskId: string,
  section: Section,
  action: "upsert" | "remove",
  generation = getProjectScopeGeneration()
) {
  const updateSections = (task: Task): Task => {
    const sections = task.sections ?? [];
    const index = sections.findIndex(
      (item) => item.type === section.type && item.order === section.order
    );

    if (action === "remove") {
      if (index === -1) return task;
      return {
        ...task,
        sections: sections.filter((_, sectionIndex) => sectionIndex !== index),
      };
    }

    if (index === -1) {
      return { ...task, sections: [...sections, section] };
    }

    const nextSections = sections.slice();
    nextSections[index] = section;
    return { ...task, sections: nextSections };
  };

  queryClient.setQueryData<Task | undefined>(
    queryKeys.tasks.detail(generation, taskId),
    (task) => (task ? updateSections(task) : task)
  );

  const lists = queryClient.getQueriesData<Task[]>({
    queryKey: queryKeys.tasks.lists(generation),
  });
  for (const [key] of lists) {
    queryClient.setQueryData<Task[] | undefined>(key, (currentTasks) =>
      currentTasks?.map((task) =>
        task.id === taskId ? updateSections(task) : task
      )
    );
  }

  mapReadyTasks(generation, (task) =>
    task.id === taskId ? updateSections(task) : task
  );
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
