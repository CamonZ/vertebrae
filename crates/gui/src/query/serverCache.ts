import type {
  Section,
  Step,
  StepExecution,
  Task,
  TaskFilterOptions,
  TaskRun,
  TaskRunTrace,
  TaskRunControls,
  Workflow,
  WorkflowTransition,
  WorkflowWithTasks,
} from "../bindings";
import {
  mergeTask,
  taskMatchesFilter,
  taskRunControlsEqual,
} from "../utils/taskMerge";
import { resolveTaskLocation } from "../utils/taskLocation";
import { getProjectScopeGeneration } from "../stores/projectScopedStores";
import { queryClient } from "./queryClient";
import { queryKeys } from "./queryKeys";

type TaskListKey = ReturnType<typeof queryKeys.tasks.list>;
type WorkflowDetailKey = ReturnType<typeof queryKeys.workflows.detail>;
const TASK_LIST_KEY_LENGTH = queryKeys.tasks.list(0, null).length;

interface UpsertStepExecutionOptions {
  taskId?: string | null;
  taskRunId?: string | null;
  generation?: number;
}

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
  filter: TaskFilterOptions | null,
  generation: number
): Task[] | undefined {
  const current = tasks ?? [];
  const index = current.findIndex((item) => item.id === task.id);
  const mergedTask = index >= 0 ? mergeTask(current[index], task) : task;

  const location = cachedTaskLocation(mergedTask, generation);

  if (!taskMatchesFilter(mergedTask, filter, location)) {
    return current.filter((item) => item.id !== task.id);
  }

  if (index === -1) return [...current, mergedTask];

  const next = current.slice();
  next[index] = mergedTask;
  return next;
}

function cachedTaskLocation(task: Task, generation: number) {
  const step = task.current_step_id
    ? queryClient.getQueryData<Step>(
        queryKeys.steps.byId(generation, task.current_step_id)
      )
    : undefined;
  const workflowId = task.workflow_id ?? step?.workflow_id;
  const workflow = workflowId
    ? queryClient
        .getQueryData<Workflow[]>(queryKeys.workflows.list(generation))
        ?.find((candidate) => candidate.id === workflowId)
    : undefined;

  return resolveTaskLocation(task, step, workflow);
}

function isRetiredFromReadyFeed(task: Task): boolean {
  return task.archived === true || Boolean(task.completed_at);
}

function shouldAppendToReadyFeed(task: Task): boolean {
  return !isRetiredFromReadyFeed(task) && task.run_controls?.runnable === true;
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

function queryEntryExists(queryKey: readonly unknown[]): boolean {
  return Boolean(queryClient.getQueryCache().find({ queryKey, exact: true }));
}

function setExistingQueryData<T>(
  queryKey: readonly unknown[],
  updater: (value: T | undefined) => T | undefined
): void {
  if (!queryEntryExists(queryKey)) return;
  queryClient.setQueryData<T | undefined>(queryKey, updater);
}

export function upsertStepExecutionInList(
  executions: readonly StepExecution[],
  execution: StepExecution
): StepExecution[] {
  const executionId = execution.id;
  if (!executionId) return [...executions, execution];

  const index = executions.findIndex((item) => item.id === executionId);
  if (index === -1) return [...executions, execution];

  const next = executions.slice();
  next[index] = execution;
  return next;
}

export function mergeFetchedStepExecutions(
  fetchedExecutions: readonly StepExecution[],
  currentExecutions: readonly StepExecution[] | undefined,
  executionsAtFetchStart: readonly StepExecution[] | undefined
): StepExecution[] {
  const currentById = new Map(
    (currentExecutions ?? [])
      .filter((execution) => execution.id)
      .map((execution) => [execution.id!, execution])
  );
  const atFetchStartById = new Map(
    (executionsAtFetchStart ?? [])
      .filter((execution) => execution.id)
      .map((execution) => [execution.id!, execution])
  );
  const fetchedIds = new Set<string>();

  const merged = fetchedExecutions.map((execution) => {
    if (!execution.id) return execution;
    fetchedIds.add(execution.id);
    const current = currentById.get(execution.id);
    const atFetchStart = atFetchStartById.get(execution.id);
    return current && current !== atFetchStart ? current : execution;
  });

  for (const execution of currentExecutions ?? []) {
    if (!execution.id) continue;
    if (fetchedIds.has(execution.id)) continue;
    if (execution === atFetchStartById.get(execution.id)) continue;
    merged.push(execution);
  }

  return merged;
}

/**
 * Merge a TaskRun fetch without allowing a websocket update received during
 * that fetch to be replaced by its older response.
 */
export function mergeFetchedTaskRuns(
  fetchedRuns: readonly TaskRun[],
  currentRuns: readonly TaskRun[] | undefined,
  runsAtFetchStart: readonly TaskRun[] | undefined
): TaskRun[] {
  const currentById = new Map((currentRuns ?? []).map((run) => [run.id, run]));
  const atFetchStartById = new Map(
    (runsAtFetchStart ?? []).map((run) => [run.id, run])
  );
  const fetchedIds = new Set<string>();

  const merged = fetchedRuns.map((run) => {
    fetchedIds.add(run.id);
    const current = currentById.get(run.id);
    return current && current !== atFetchStartById.get(run.id) ? current : run;
  });

  for (const run of currentRuns ?? []) {
    if (!fetchedIds.has(run.id) && run !== atFetchStartById.get(run.id)) {
      merged.push(run);
    }
  }
  return merged;
}

export function upsertTaskRunInQueryCache(
  taskRun: TaskRun,
  generation = getProjectScopeGeneration()
) {
  const key = queryKeys.taskRuns.byTask(generation, taskRun.task_id);
  queryClient.setQueryData<TaskRun[]>(key, (runs = []) => {
    const index = runs.findIndex((run) => run.id === taskRun.id);
    if (index === -1) return [...runs, taskRun];
    const next = runs.slice();
    next[index] = taskRun;
    return next;
  });
}

export function removeTaskRunsFromQueryCache(
  taskId: string,
  generation = getProjectScopeGeneration()
) {
  queryClient.removeQueries({
    queryKey: queryKeys.taskRuns.byTask(generation, taskId),
  });
}

export function mergeFetchedTaskRunTrace(
  fetchedTrace: TaskRunTrace,
  currentTrace: TaskRunTrace | undefined,
  traceAtFetchStart: TaskRunTrace | undefined
): TaskRunTrace {
  return {
    ...fetchedTrace,
    step_executions: mergeFetchedStepExecutions(
      fetchedTrace.step_executions ?? [],
      currentTrace?.step_executions,
      traceAtFetchStart?.step_executions
    ),
  };
}

export function upsertStepExecutionInQueryCache(
  execution: StepExecution,
  options: UpsertStepExecutionOptions = {}
) {
  const generation = options.generation ?? getProjectScopeGeneration();
  const taskId = options.taskId ?? execution.task_id ?? null;
  const taskRunId = options.taskRunId ?? execution.task_run_id ?? null;

  if (taskId) {
    setExistingQueryData<StepExecution[]>(
      queryKeys.executions.byTask(generation, taskId),
      (executions) => upsertStepExecutionInList(executions ?? [], execution)
    );
  }

  if (taskRunId) {
    setExistingQueryData<TaskRunTrace>(
      queryKeys.executions.byRun(generation, taskRunId),
      (trace) => ({
        root_task_run_id: trace?.root_task_run_id ?? taskRunId,
        task_runs: trace?.task_runs ?? [],
        step_executions: upsertStepExecutionInList(
          trace?.step_executions ?? [],
          execution
        ),
        session_logs: [],
      })
    );
  }
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
        : reconcileTaskList(currentTasks, task, filter, generation)
    );
  }
}

/** Update only persisted task location IDs after a movement event. */
export function updateTaskLocationInQueryCache(
  taskId: string,
  currentStepId: string | null,
  workflowId: string | null | undefined,
  generation = getProjectScopeGeneration()
) {
  const update = (task: Task): Task => ({
    ...task,
    current_step_id: currentStepId,
    ...(workflowId !== undefined ? { workflow_id: workflowId } : {}),
  });

  queryClient.setQueryData<Task | undefined>(
    queryKeys.tasks.detail(generation, taskId),
    (task) => (task ? update(task) : task)
  );
  for (const [key] of queryClient.getQueriesData<Task[]>({
    queryKey: queryKeys.tasks.lists(generation),
  })) {
    const filter = taskListFilterFromKey(key);
    queryClient.setQueryData<Task[] | undefined>(key, (tasks) => {
      const existing = tasks?.find((task) => task.id === taskId);
      return existing
        ? reconcileTaskList(tasks, update(existing), filter, generation)
        : tasks;
    });
  }
  queryClient.setQueryData<Task[] | undefined>(
    queryKeys.tasks.ready(generation),
    (tasks) => tasks?.map((task) => (task.id === taskId ? update(task) : task))
  );
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

export function upsertStepInQueryCache(
  step: Step,
  generation = getProjectScopeGeneration()
) {
  if (!step.id) return;
  queryClient.setQueryData<Step | null>(
    queryKeys.steps.byId(generation, step.id),
    (existing) => (existing ? { ...existing, ...step } : step)
  );
}

export function removeStepFromQueryCache(
  stepId: string,
  generation = getProjectScopeGeneration()
) {
  queryClient.removeQueries({
    queryKey: queryKeys.steps.byId(generation, stepId),
    exact: true,
  });
}

export function upsertWorkflowTransitionInQueryCache(
  transition: WorkflowTransition,
  generation = getProjectScopeGeneration()
) {
  queryClient.setQueryData<WorkflowTransition[]>(
    queryKeys.workflowTransitions.list(generation),
    (transitions = []) => {
      const index = transitions.findIndex((item) => item.id === transition.id);
      if (index < 0) return [...transitions, transition];
      const next = transitions.slice();
      next[index] = transition;
      return next;
    }
  );
}

export function removeWorkflowTransitionFromQueryCache(
  transitionId: string,
  generation = getProjectScopeGeneration()
) {
  queryClient.setQueryData<WorkflowTransition[]>(
    queryKeys.workflowTransitions.list(generation),
    (transitions) =>
      transitions?.filter((transition) => transition.id !== transitionId)
  );
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
