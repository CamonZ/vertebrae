import type { TaskFilterOptions } from "../bindings";

export const queryKeys = {
  project: (generation: number) => ["project", generation] as const,
  tasks: {
    all: (generation: number) =>
      [...queryKeys.project(generation), "tasks"] as const,
    lists: (generation: number) =>
      [...queryKeys.tasks.all(generation), "list"] as const,
    list: (generation: number, filter: TaskFilterOptions | null) =>
      [...queryKeys.tasks.lists(generation), filter] as const,
    ready: (generation: number) =>
      [...queryKeys.tasks.all(generation), "ready"] as const,
    details: (generation: number) =>
      [...queryKeys.tasks.all(generation), "detail"] as const,
    detail: (generation: number, id: string) =>
      [...queryKeys.tasks.details(generation), id] as const,
  },
  workflows: {
    all: (generation: number) =>
      [...queryKeys.project(generation), "workflows"] as const,
    list: (generation: number) =>
      [...queryKeys.workflows.all(generation), "list"] as const,
    details: (generation: number) =>
      [...queryKeys.workflows.all(generation), "detail"] as const,
    detail: (generation: number, id: string) =>
      [...queryKeys.workflows.details(generation), id] as const,
  },
  steps: {
    all: (generation: number) =>
      [...queryKeys.project(generation), "steps"] as const,
    byId: (generation: number, stepId: string) =>
      [...queryKeys.steps.all(generation), "byId", stepId] as const,
  },
  workflowTransitions: {
    all: (generation: number) =>
      [...queryKeys.project(generation), "workflowTransitions"] as const,
    list: (generation: number) =>
      [...queryKeys.workflowTransitions.all(generation), "list"] as const,
  },
  pipelineSummary: (generation: number) =>
    [...queryKeys.project(generation), "pipelineSummary"] as const,
  executions: {
    all: (generation: number) =>
      [...queryKeys.project(generation), "executions"] as const,
    byTask: (generation: number, taskId: string) =>
      [...queryKeys.executions.all(generation), "byTask", taskId] as const,
    byRun: (generation: number, runId: string) =>
      [...queryKeys.executions.all(generation), "byRun", runId] as const,
  },
  taskRuns: {
    all: (generation: number) =>
      [...queryKeys.project(generation), "taskRuns"] as const,
    byTask: (generation: number, taskId: string) =>
      [...queryKeys.taskRuns.all(generation), "byTask", taskId] as const,
  },
};
