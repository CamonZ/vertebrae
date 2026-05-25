import { useEffect, useMemo, useRef } from "react";
import { commands, type Task, type TaskFilterOptions } from "../bindings";
import { useTaskStore, useExecutionStore } from "../stores";
import {
  getProjectScopeGeneration,
  isCurrentProjectScopeGeneration,
} from "../stores/projectScopedStores";
import { useTasks } from "./useTasks";
import type { AttentionItem } from "../components/Operations/NeedsAttentionSection";
import type { LiveItem } from "../components/Operations/LiveSection";
import type { CompletedItem } from "../components/Operations/RecentlyCompletedSection";
import { deriveActiveTaskRuns, isActiveRunStatus } from "../utils/runState";

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

/**
 * Hook that aggregates data for the Operations dashboard.
 *
 * Uses the same store-based pattern as BoardPage and TasksPage:
 * - useTasks() fetches and syncs to TaskStore
 * - GlobalListeners keeps TaskStore and ExecutionStore live via WebSocket
 * - Executions for active tasks are seeded on mount
 * - Sections are derived from store state
 */
export function useOperationsData(): OperationsData {
  const { isLoading, error, refetch } = useTasks(ALL_TASKS_FILTER);
  const tasks = useTaskStore((s) => s.tasks);
  const executions = useExecutionStore((s) => s.executions);
  const upsertExecution = useExecutionStore((s) => s.upsertExecution);

  const activeTaskIds = useMemo(() => {
    const ids: string[] = [];
    for (const t of tasks) {
      if (isActiveRunStatus(t.run_controls?.active_run?.status ?? null)) {
        ids.push(t.id);
      }
    }
    return ids;
  }, [tasks]);

  const seededTaskIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const newlyActive = activeTaskIds.filter(
      (id) => !seededTaskIdsRef.current.has(id)
    );
    if (newlyActive.length === 0) return;

    let cancelled = false;
    const projectScopeGeneration = getProjectScopeGeneration();
    for (const id of newlyActive) seededTaskIdsRef.current.add(id);

    (async () => {
      const results = await Promise.all(
        newlyActive.map((id) =>
          commands
            .getTaskExecutions(id)
            .then((r) => (r.status === "ok" ? r.data : []))
        )
      );
      if (
        cancelled ||
        !isCurrentProjectScopeGeneration(projectScopeGeneration)
      ) {
        return;
      }
      for (const list of results) {
        for (const exec of list) upsertExecution(exec);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeTaskIds, upsertExecution]);

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
      const failedRun = task.run_controls?.active_run;
      if (failedRun && failedRun.status === "failed") {
        items.push({ kind: "failed_run", task, taskRun: failedRun });
      }
    }

    return items;
  }, [tasks]);

  // Excludes "stopping" — that transition is signalled via the run chip/Stop
  // button, not the Live tile.
  const liveItems = useMemo<LiveItem[]>(
    () => deriveActiveTaskRuns(tasks, { includeStopping: false }),
    [tasks]
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

  const readyTasks = useMemo<Task[]>(() => {
    return tasks.filter((t) => {
      if (t.archived) return false;
      if (isActiveRunStatus(t.run_controls?.active_run?.status ?? null)) {
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
          const depRunStatus = dep.run_controls?.active_run?.status ?? null;
          if (depRunStatus === "completed") return true;
          return dep.step_name === "done";
        });
      }
      return true;
    });
  }, [tasks, taskMap]);

  return {
    attentionItems,
    liveItems,
    completedItems,
    readyTasks,
    isLoading,
    error,
    refetch,
  };
}
