import { useEffect, useMemo } from "react";
import { commands, type Task, type TaskFilterOptions } from "../bindings";
import { useTaskStore, useExecutionStore } from "../stores";
import { useTasks } from "./useTasks";
import type { AttentionItem } from "../components/Operations/NeedsAttentionSection";
import type { LiveItem } from "../components/Operations/LiveSection";
import type { CompletedItem } from "../components/Operations/RecentlyCompletedSection";

const ALL_TASKS_FILTER: TaskFilterOptions = {
  step_names: null,
  levels: null,
  tags: null,
  root_only: null,
  children_of: null,
  include_done: true,
  search: null,
  workflow_id: null,
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
  const setExecutions = useExecutionStore((s) => s.setExecutions);

  // Seed the ExecutionStore with executions for active tasks on mount.
  // After this, the store stays live via GlobalListeners.
  const activeTasks = useMemo(
    () => tasks.filter((t) => t.workflow_id && t.started_at && !t.completed_at),
    [tasks],
  );

  useEffect(() => {
    if (activeTasks.length === 0) return;

    let cancelled = false;

    async function seedExecutions() {
      const results = await Promise.all(
        activeTasks.map((t) =>
          commands.getTaskExecutions(t.id).then((r) =>
            r.status === "ok" ? r.data : [],
          ),
        ),
      );
      if (!cancelled) {
        setExecutions(results.flat());
      }
    }

    seedExecutions();
    return () => { cancelled = true; };
  }, [activeTasks, setExecutions]);

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

    for (const exec of executions) {
      if (exec.status !== "failed") continue;
      const task = exec.task_id ? taskMap.get(exec.task_id) : undefined;
      if (task) {
        items.push({ kind: "failed_execution", task, execution: exec });
      }
    }

    for (const task of tasks) {
      if (task.needs_human_review) {
        items.push({ kind: "review_request", task });
      }
    }

    return items;
  }, [executions, tasks, taskMap]);

  // Only show as "live" if the execution is for the task's CURRENT step.
  // Old in_progress executions for previous steps are stale.
  const liveItems = useMemo<LiveItem[]>(() => {
    return executions
      .filter((e) => e.status === "in_progress")
      .map((exec) => {
        const task = exec.task_id ? taskMap.get(exec.task_id) : undefined;
        if (!task) return null;
        if (task.step_name !== exec.step_name) return null;
        return { task, execution: exec };
      })
      .filter((item): item is LiveItem => item != null);
  }, [executions, taskMap]);

  const completedItems = useMemo<CompletedItem[]>(() => {
    return executions
      .filter((e) => e.status === "completed" && e.completed_at)
      .sort((a, b) =>
        new Date(b.completed_at!).getTime() - new Date(a.completed_at!).getTime(),
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
      if (t.started_at) return false;
      if (t.completed_at) return false;
      if (t.archived) return false;
      const deps = t.dependency_ids ?? [];
      if (deps.length > 0) {
        return deps.every((depId) => taskMap.get(depId)?.completed_at != null);
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
