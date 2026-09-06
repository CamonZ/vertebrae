import type { TaskFilterOptions } from "../bindings";

/** Collapse equivalent unfiltered filters to one project-scoped cache key. */
export function normalizeTaskFilter(
  filter: TaskFilterOptions | null | undefined
): TaskFilterOptions | null {
  if (!filter) return null;
  return Object.values(filter).every((value) => value === null) ? null : filter;
}

export const queryKeys = {
  project: (generation: number) => ["project", generation] as const,
  /**
   * Backend/account connection identity resolution. Account-scoped server
   * state keys off this identity, never off the selected project.
   */
  sacrumConnection: () => ["sacrumConnection"] as const,
  daemons: {
    /**
     * Sentinel connection-id segment for daemon queries whose backend/account
     * identity has not resolved yet. Those queries stay disabled until the
     * identity resolves; the sentinel keeps their keys stable in the
     * meantime. Defined here so the hooks never spell the literal twice.
     */
    unresolved: "unresolved",
    all: (connectionId: string) => ["sacrum", connectionId, "daemons"] as const,
    fleet: (connectionId: string) =>
      [...queryKeys.daemons.all(connectionId), "fleet"] as const,
    details: (connectionId: string) =>
      [...queryKeys.daemons.all(connectionId), "detail"] as const,
    detail: (connectionId: string, daemonId: string) =>
      [...queryKeys.daemons.details(connectionId), daemonId] as const,
    enrollment: (connectionId: string, daemonId: string) =>
      [...queryKeys.daemons.all(connectionId), "enrollment", daemonId] as const,
  },
  tasks: {
    all: (generation: number) =>
      [...queryKeys.project(generation), "tasks"] as const,
    lists: (generation: number) =>
      [...queryKeys.tasks.all(generation), "list"] as const,
    list: (generation: number, filter: TaskFilterOptions | null | undefined) =>
      [
        ...queryKeys.tasks.lists(generation),
        normalizeTaskFilter(filter),
      ] as const,
    ready: (generation: number) =>
      [...queryKeys.tasks.all(generation), "ready"] as const,
    details: (generation: number) =>
      [...queryKeys.tasks.all(generation), "detail"] as const,
    detail: (generation: number, id: string) =>
      [...queryKeys.tasks.details(generation), id] as const,
  },
  artifacts: {
    all: (generation: number) =>
      [...queryKeys.project(generation), "artifacts"] as const,
    project: (generation: number) =>
      [...queryKeys.artifacts.all(generation), "project"] as const,
    task: (generation: number, taskId: string) =>
      [...queryKeys.artifacts.all(generation), "task", taskId] as const,
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

/**
 * Whether a query key belongs to the account-scoped Sacrum namespace — the
 * connection-identity query and the identity-scoped daemon subtree — rather
 * than to the selected project.
 *
 * Project-scope resets preserve these entries (their scope is the
 * backend/account identity, not the project) and re-validate the connection
 * query instead, so account-scoped caches survive a project switch on the
 * same backend/account.
 */
export function isSacrumQueryKey(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === "sacrumConnection" || queryKey[0] === "sacrum";
}
