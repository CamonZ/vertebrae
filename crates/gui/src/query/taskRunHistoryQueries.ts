import type { InfiniteData } from "@tanstack/react-query";
import {
  commands,
  type Task,
  type TaskRun,
  type TaskRunHistoryCursor,
  type TaskRunHistoryEntry,
  type TaskRunHistoryPage,
  type TaskRunHistoryTask,
} from "../bindings";
import { unwrapCommand } from "./commandResult";
import { queryClient } from "./queryClient";
import { queryKeys } from "./queryKeys";

export const TASK_RUN_HISTORY_PAGE_SIZE = 50;

/**
 * Collapsing chat unmounts the history sidebar. Keep its pages long enough
 * that expanding again is a presentation change, not a reload; realtime
 * updates keep inactive pages current meanwhile.
 */
export const TASK_RUN_HISTORY_GC_TIME_MS = 30 * 60 * 1000;

/** A fetched page plus the cursor the server order implies after it. */
export interface CachedTaskRunHistoryPage extends TaskRunHistoryPage {
  /**
   * Captured at fetch time: realtime updates move a cached entry's
   * `updated_at`, which must not move where the next page starts.
   */
  next: TaskRunHistoryCursor | null;
}

export type TaskRunHistoryData = InfiniteData<
  CachedTaskRunHistoryPage,
  TaskRunHistoryCursor | null
>;

type HistoryKey = ReturnType<typeof queryKeys.taskRunHistory.list>;

/** Finished runs that count as completed history; failed runs stay visible. */
export function isCompletedRun(run: Pick<TaskRun, "status">): boolean {
  return run.status === "completed" || run.status === "stopped";
}

function timeMs(value: string | null | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** The newer of two snapshots of one run; ties keep `current`. */
function newerRun(current: TaskRun, incoming: TaskRun): TaskRun {
  return timeMs(incoming.updated_at) > timeMs(current.updated_at)
    ? incoming
    : current;
}

function cachedRunsById(data: TaskRunHistoryData | undefined) {
  const runs = new Map<string, TaskRun>();
  for (const page of data?.pages ?? [])
    for (const entry of page.entries)
      runs.set(entry.task_run.id, entry.task_run);
  return runs;
}

export function taskRunHistoryQueryOptions(
  generation: number,
  includeCompleted: boolean,
  search: string
) {
  const queryKey = queryKeys.taskRunHistory.list(
    generation,
    includeCompleted,
    search
  );
  return {
    queryKey,
    initialPageParam: null as TaskRunHistoryCursor | null,
    gcTime: TASK_RUN_HISTORY_GC_TIME_MS,
    queryFn: async ({
      pageParam,
    }: {
      pageParam: TaskRunHistoryCursor | null;
    }): Promise<CachedTaskRunHistoryPage> => {
      const page = await unwrapCommand(
        commands.getTaskRunHistory(
          includeCompleted,
          search || null,
          pageParam,
          TASK_RUN_HISTORY_PAGE_SIZE
        )
      );
      const last = page.entries.at(-1)?.task_run;
      const next =
        page.has_more && last?.updated_at
          ? { updated_at: last.updated_at, id: last.id }
          : null;
      // A websocket update applied while this page was in flight is newer
      // than the response; keep it.
      const current = cachedRunsById(
        queryClient.getQueryData<TaskRunHistoryData>(queryKey)
      );
      const entries = page.entries.map((entry) => {
        const cached = current.get(entry.task_run.id);
        const run = cached ? newerRun(entry.task_run, cached) : entry.task_run;
        return run === entry.task_run ? entry : { ...entry, task_run: run };
      });
      return { ...page, entries, next };
    },
    getNextPageParam: (lastPage: CachedTaskRunHistoryPage) =>
      lastPage.next ?? undefined,
  };
}

function historyKeyParams(key: readonly unknown[]) {
  const params = key[key.length - 1] as {
    includeCompleted: boolean;
    search: string;
  };
  return params;
}

/** Search matches the task title, or a task/run id (full or prefix). */
export function historyRunMatchesQuery(
  run: Pick<TaskRun, "id" | "task_id">,
  task: Pick<TaskRunHistoryTask, "title"> | undefined,
  query: string
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return (
    run.id.toLowerCase().startsWith(normalized) ||
    run.task_id.toLowerCase().startsWith(normalized) ||
    (task?.title.toLowerCase().includes(normalized) ?? false)
  );
}

function historyTaskFromTask(task: Task): TaskRunHistoryTask {
  return {
    id: task.id,
    title: task.title,
    level: task.level ?? "task",
    parent_id: task.parent_id ?? null,
    workflow_id: task.workflow_id ?? null,
    workflow_name: task.workflow_name ?? null,
    completed_at: task.completed_at ?? null,
  };
}

/** The freshest known task for a run that is not in a history page yet. */
function cachedTask(generation: number, taskId: string): Task | undefined {
  const detail = queryClient.getQueryData<Task>(
    queryKeys.tasks.detail(generation, taskId)
  );
  if (detail) return detail;
  for (const [, tasks] of queryClient.getQueriesData<Task[]>({
    queryKey: queryKeys.tasks.lists(generation),
  })) {
    const task = tasks?.find((candidate) => candidate.id === taskId);
    if (task) return task;
  }
  return undefined;
}

function historyTaskFor(
  data: TaskRunHistoryData,
  generation: number,
  taskId: string
): { task: TaskRunHistoryTask; archived: boolean } | undefined {
  const task = cachedTask(generation, taskId);
  if (task)
    return { task: historyTaskFromTask(task), archived: !!task.archived };
  for (const page of data.pages)
    for (const entry of page.entries)
      if (entry.task.id === taskId)
        return { task: entry.task, archived: false };
  return undefined;
}

function hiddenByCompletion(
  run: TaskRun,
  task: Pick<TaskRunHistoryTask, "completed_at">,
  includeCompleted: boolean
) {
  return !includeCompleted && (!!task.completed_at || isCompletedRun(run));
}

/** Server semantics: only finished runs of open tasks count as hidden. */
function countsAsHidden(
  run: TaskRun,
  task: Pick<TaskRunHistoryTask, "completed_at">
) {
  return !task.completed_at && isCompletedRun(run);
}

function applyRunToHistory(
  data: TaskRunHistoryData,
  key: HistoryKey,
  run: TaskRun,
  generation: number
): TaskRunHistoryData | "unknown_task" {
  const { includeCompleted, search } = historyKeyParams(key);
  let found = false;
  let changed = false;
  let hiddenDelta = 0;

  const pages = data.pages.map((page) => {
    const index = page.entries.findIndex(
      (entry) => entry.task_run.id === run.id
    );
    if (index === -1) return page;
    found = true;
    const entry = page.entries[index];
    const nextRun = newerRun(entry.task_run, run);
    if (nextRun === entry.task_run) return page;
    changed = true;
    const entries = page.entries.slice();
    if (hiddenByCompletion(nextRun, entry.task, includeCompleted)) {
      // Shown until now: this is the one event that moves it into the count.
      entries.splice(index, 1);
      if (countsAsHidden(nextRun, entry.task)) hiddenDelta += 1;
    } else {
      entries[index] = { ...entry, task_run: nextRun };
    }
    return { ...page, entries };
  });

  if (!found) {
    // A hidden run outside the list is either counted by the server already
    // or was counted when it left the list; counting it again would drift.
    if (!includeCompleted && isCompletedRun(run)) return data;
    const known = historyTaskFor(data, generation, run.task_id);
    if (!known) return "unknown_task";
    if (
      known.archived ||
      !historyRunMatchesQuery(run, known.task, search) ||
      hiddenByCompletion(run, known.task, includeCompleted) ||
      pages.length === 0
    )
      return data;
    const entry: TaskRunHistoryEntry = { task_run: run, task: known.task };
    pages[0] = { ...pages[0], entries: [entry, ...pages[0].entries] };
    changed = true;
  }

  if (!changed) return data;
  if (hiddenDelta && pages.length > 0) {
    pages[0] = {
      ...pages[0],
      hidden_completed_count: pages[0].hidden_completed_count + hiddenDelta,
    };
  }
  return { ...data, pages };
}

/**
 * Apply a realtime TaskRun to every cached history list of the project:
 * update it in place, drop it once the completed filter hides it, or add a
 * new run to the first page. A run whose task no cache knows cannot be
 * labelled, so that list is reconciled with the server instead.
 */
export function upsertTaskRunInHistoryCache(run: TaskRun, generation: number) {
  for (const [key, data] of queryClient.getQueriesData<TaskRunHistoryData>({
    queryKey: queryKeys.taskRunHistory.all(generation),
  })) {
    if (!data) continue;
    const next = applyRunToHistory(data, key as HistoryKey, run, generation);
    if (next === "unknown_task") {
      void queryClient.invalidateQueries({ queryKey: key, exact: true });
    } else if (next !== data) {
      queryClient.setQueryData<TaskRunHistoryData>(key, next);
    }
  }
}

/** Drop a deleted task's runs from every cached history list. */
export function removeTaskFromHistoryCache(taskId: string, generation: number) {
  queryClient.setQueriesData<TaskRunHistoryData>(
    { queryKey: queryKeys.taskRunHistory.all(generation) },
    (data) =>
      data && {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          entries: page.entries.filter((entry) => entry.task.id !== taskId),
        })),
      }
  );
}

/**
 * Recover changes a disconnected websocket may have dropped. Mounted lists
 * reload their loaded pages; unmounted ones reload when next shown.
 */
export function reconcileTaskRunHistory(generation: number) {
  void queryClient.invalidateQueries({
    queryKey: queryKeys.taskRunHistory.all(generation),
  });
}
