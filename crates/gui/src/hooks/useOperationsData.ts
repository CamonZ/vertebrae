import { useCallback, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import type { Task, TaskFilterOptions } from "../bindings";
import { useProjectScopeGeneration } from "../stores/projectScopedStores";
import { useTasks } from "./useTasks";
import { useTaskRunsForTasks } from "./useTaskRuns";
import type { AttentionItem } from "../components/Operations/NeedsAttentionSection";
import type { LiveItem } from "../components/Operations/LiveSection";
import type { CompletedItem } from "../components/Operations/RecentlyCompletedSection";
import { deriveActiveTaskRuns, isActiveRunStatus } from "../utils/runState";
import {
  errorMessage,
  queryClient,
  queryKeys,
  taskExecutionsQueryOptions,
} from "../query";

const ALL_TASKS_FILTER: TaskFilterOptions = {
  step_names: null,
  levels: null,
  tags: null,
  root_only: null,
  children_of: null,
  search: null,
  workflow_id: null,
  step_id: null,
};

interface OperationsData {
  attentionItems: AttentionItem[];
  liveItems: LiveItem[];
  completedItems: CompletedItem[];
  readyTasks: Task[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

const observedExecutionTaskIdsByGeneration = new Map<number, Set<string>>();

function observedExecutionTaskIds(generation: number): Set<string> {
  for (const existingGeneration of observedExecutionTaskIdsByGeneration.keys()) {
    if (existingGeneration !== generation) {
      observedExecutionTaskIdsByGeneration.delete(existingGeneration);
    }
  }

  const existing = observedExecutionTaskIdsByGeneration.get(generation);
  if (existing) return existing;
  const created = new Set<string>();
  observedExecutionTaskIdsByGeneration.set(generation, created);
  return created;
}

function hasTaskExecutionsQuery(generation: number, taskId: string): boolean {
  return Boolean(
    queryClient.getQueryCache().find({
      queryKey: queryKeys.executions.byTask(generation, taskId),
      exact: true,
    })
  );
}

/**
 * Hook that aggregates data for the Operations dashboard.
 *
 * Uses TanStack Query for task server state:
 * - useTasks() fetches the task list
 * - GlobalListeners keeps task and execution query data live via WebSocket
 * - Executions for active or previously observed runs are read from by-task queries
 * - Sections are derived from query task data
 */
export function useOperationsData(): OperationsData {
  const {
    tasks,
    isLoading: tasksLoading,
    error: tasksError,
    refetch: refetchTasks,
  } = useTasks(ALL_TASKS_FILTER);
  const { activeRunsByTaskId, latestRunsByTaskId } = useTaskRunsForTasks(
    tasks.map((task) => task.id)
  );
  const projectScopeGeneration = useProjectScopeGeneration();

  const executionTaskIds = useMemo(() => {
    const observedTaskIds = observedExecutionTaskIds(projectScopeGeneration);
    const taskIds: string[] = [];

    for (const task of tasks) {
      if (
        activeRunsByTaskId.has(task.id) ||
        hasTaskExecutionsQuery(projectScopeGeneration, task.id)
      ) {
        observedTaskIds.add(task.id);
      }

      if (observedTaskIds.has(task.id)) {
        taskIds.push(task.id);
      }
    }

    return taskIds;
  }, [activeRunsByTaskId, projectScopeGeneration, tasks]);

  const executionQueries = useQueries({
    queries: executionTaskIds.map((taskId) =>
      taskExecutionsQueryOptions(projectScopeGeneration, taskId)
    ),
    combine: (results) => ({
      executions: results.flatMap((query) => query.data ?? []),
      firstError: results.find((query) => query.error)?.error,
      isLoading: results.some((query) => query.isLoading),
      refetch: () => {
        void Promise.all(results.map((query) => query.refetch()));
      },
    }),
  });

  const executions = executionQueries.executions;

  const refetch = useCallback(() => {
    refetchTasks();
    executionQueries.refetch();
  }, [executionQueries, refetchTasks]);

  // Build a task lookup map for joining executions to tasks
  const taskMap = useMemo(() => {
    const map = new Map<string, Task>();
    for (const task of tasks) {
      map.set(task.id, task);
    }
    return map;
  }, [tasks]);

  const attentionItems = useMemo<AttentionItem[]>(() => {
    const items: AttentionItem[] = [];

    for (const task of tasks) {
      const failedRun = latestRunsByTaskId.get(task.id);
      if (failedRun && failedRun.status === "failed") {
        items.push({ kind: "failed_run", task, taskRun: failedRun });
      }
    }

    return items;
  }, [latestRunsByTaskId, tasks]);

  // Excludes "stopping" — that transition is signalled via the run chip/Stop
  // button, not the Live tile.
  const liveItems = useMemo<LiveItem[]>(
    () =>
      deriveActiveTaskRuns(tasks, activeRunsByTaskId, {
        includeStopping: false,
      }),
    [activeRunsByTaskId, tasks]
  );

  const completedItems = useMemo<CompletedItem[]>(() => {
    return executions
      .filter((e) => e.status === "completed" && e.completed_at)
      .sort(
        (a, b) =>
          new Date(b.completed_at!).getTime() -
          new Date(a.completed_at!).getTime()
      )
      .slice(0, 20)
      .map((exec) => {
        const task = exec.task_id ? taskMap.get(exec.task_id) : undefined;
        return task ? { task, execution: exec } : null;
      })
      .filter((item): item is CompletedItem => item != null);
  }, [executions, taskMap]);

  const firstExecutionError = executionQueries.firstError;

  const readyTasks = useMemo<Task[]>(() => {
    return tasks.filter((t) => {
      if (t.archived) return false;
      if (isActiveRunStatus(activeRunsByTaskId.get(t.id)?.status ?? null)) {
        return false;
      }
      const controls = t.run_controls;
      if (controls && controls.runnable !== true) {
        return false;
      }
      if (!controls && !t.workflow_id) {
        return false;
      }
      const deps = t.dependency_ids ?? [];
      if (deps.length > 0) {
        return deps.every((depId) => {
          const dep = taskMap.get(depId);
          if (!dep) return false;
          const depRunStatus = latestRunsByTaskId.get(dep.id)?.status ?? null;
          if (depRunStatus === "completed") return true;
          return Boolean(dep.completed_at);
        });
      }
      return true;
    });
  }, [activeRunsByTaskId, latestRunsByTaskId, tasks, taskMap]);

  return {
    attentionItems,
    liveItems,
    completedItems,
    readyTasks,
    isLoading: tasksLoading || executionQueries.isLoading,
    error:
      tasksError ??
      (firstExecutionError ? errorMessage(firstExecutionError) : null),
    refetch,
  };
}
