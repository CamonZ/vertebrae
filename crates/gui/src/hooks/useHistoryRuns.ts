import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { Task, TaskRun, TaskRunHistoryTask } from "../bindings";
import {
  queryClient,
  taskRunHistoryQueryOptions,
  type TaskRunHistoryData,
} from "../query";
import {
  historyRunMatchesQuery,
  isCompletedRun,
} from "../query/taskRunHistoryQueries";
import { useProjectScopeGeneration } from "../stores/projectScopedStores";
import { normalizeLocalChatSessionQuery } from "../utils/localChatSessionGroups";
import type { LocalChatRunRow } from "../utils/localChatSessionGroups";
import { useTasks } from "./useTasks";

export { isCompletedRun };

/** Typing settles before a search reaches the server. */
export const HISTORY_SEARCH_DEBOUNCE_MS = 200;

export function runActivityAt(run: TaskRun): string {
  return (
    run.updated_at ??
    run.ended_at ??
    run.started_at ??
    run.inserted_at ??
    new Date(0).toISOString()
  );
}

/** Search matches the task title, or a task/run id (full or prefix). */
export function runMatchesQuery(
  run: Pick<TaskRun, "id" | "task_id">,
  task: Pick<Task, "title"> | undefined,
  query: string
): boolean {
  return historyRunMatchesQuery(run, task, query);
}

interface UseHistoryRunsOptions {
  /** Runs live in the backend's current project only. */
  enabled: boolean;
  showCompleted: boolean;
  searchQuery: string;
}

export interface HistoryRuns {
  rows: LocalChatRunRow[];
  /** Matching runs hidden by the completed filter. */
  hiddenCompletedCount: number;
  /** Current-project task metadata for grouping run tasks. */
  tasksById: ReadonlyMap<string, Task>;
  /** More history exists beyond the loaded pages. */
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (Object.is(value, debounced)) return;
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, debounced, delayMs]);
  return debounced;
}

/** Page task fields as a Task, for groups whose task the list lacks. */
function taskFromHistory(task: TaskRunHistoryTask): Task {
  return {
    id: task.id,
    title: task.title,
    level: task.level,
    parent_id: task.parent_id,
    workflow_id: task.workflow_id,
    workflow_name: task.workflow_name,
    completed_at: task.completed_at,
    description: null,
    priority: null,
    current_step_id: null,
    step_name: null,
    step_type: null,
    worktree: null,
    rejection_reason: null,
    created_at: null,
    updated_at: null,
    started_at: null,
  };
}

/**
 * Run rows for the chat history panel, from one project-scoped, paginated
 * history query: the initial load is one request whatever the project's task
 * count. Pages are cached per project and filter, so collapsing and expanding
 * chat reuses them; realtime TaskRun events keep them current. The live task
 * list refreshes labels and completion between history fetches.
 */
export function useHistoryRuns({
  enabled,
  showCompleted,
  searchQuery,
}: UseHistoryRunsOptions): HistoryRuns {
  const generation = useProjectScopeGeneration();
  const { tasks } = useTasks(undefined, { enabled });
  const search = useDebouncedValue(
    normalizeLocalChatSessionQuery(searchQuery),
    HISTORY_SEARCH_DEBOUNCE_MS
  );

  const { data, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useInfiniteQuery(
      {
        ...taskRunHistoryQueryOptions(generation, showCompleted, search),
        enabled,
        // Keep the previous filter's rows while the next one loads, within one
        // project only.
        placeholderData: (
          previous: TaskRunHistoryData | undefined,
          previousQuery
        ) => (previousQuery?.queryKey[1] === generation ? previous : undefined),
      },
      queryClient
    );

  const liveTasksById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks]
  );

  const pages = enabled ? data?.pages : undefined;

  return useMemo(() => {
    const rows: LocalChatRunRow[] = [];
    const tasksById = new Map(liveTasksById);
    const seen = new Set<string>();
    const hiddenCompletedCount = pages?.[0]?.hidden_completed_count ?? 0;

    for (const page of pages ?? []) {
      for (const { task_run: run, task: pageTask } of page.entries) {
        if (seen.has(run.id)) continue;
        seen.add(run.id);

        const live = liveTasksById.get(pageTask.id);
        if (live?.archived) continue;
        if (!tasksById.has(pageTask.id))
          tasksById.set(pageTask.id, taskFromHistory(pageTask));

        const task = live ?? taskFromHistory(pageTask);
        // The live task wins: completion and titles change between fetches.
        if (!runMatchesQuery(run, task, searchQuery)) continue;
        const completed = !!task.completed_at || isCompletedRun(run);
        if (completed && !showCompleted) continue;

        rows.push({
          id: run.id,
          taskId: task.id,
          run,
          label: task.workflow_name ? `${task.workflow_name} run` : "Run",
          updatedAt: runActivityAt(run),
          completed,
        });
      }
    }

    return {
      rows,
      hiddenCompletedCount,
      tasksById,
      hasMore: enabled && hasNextPage,
      loadingMore: isFetchingNextPage,
      loadMore: () => {
        if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
      },
    };
  }, [
    enabled,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    liveTasksById,
    pages,
    searchQuery,
    showCompleted,
  ]);
}
