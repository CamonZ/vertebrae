import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createMockTask, createMockTaskRun } from "../test/test-utils";
import {
  hydrateActiveTaskRunsFromTasks,
  queryClient,
  queryKeys,
  reconcileTaskRunHistory,
  upsertTaskRunInHistoryCache,
} from "../query";
import { removeTaskFromQueryCache } from "../query/serverCache";
import {
  getProjectScopeGeneration,
  resetProjectScopedStores,
} from "../stores/projectScopedStores";
import type {
  Task,
  TaskRun,
  TaskRunHistoryCursor,
  TaskRunHistoryPage,
} from "../bindings";
import {
  HISTORY_SEARCH_DEBOUNCE_MS,
  isCompletedRun,
  runMatchesQuery,
  useHistoryRuns,
} from "./useHistoryRuns";

const mocks = vi.hoisted(() => ({
  tasks: [] as Task[],
  server: {
    runs: [] as TaskRun[],
    tasks: new Map<string, Task>(),
  },
  getTaskRunHistory: vi.fn(),
  getTaskRuns: vi.fn(),
}));

vi.mock("./useTasks", () => ({
  useTasks: () => ({ tasks: mocks.tasks }),
}));

vi.mock("../bindings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bindings")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      getTaskRuns: mocks.getTaskRuns,
      getTaskRunHistory: mocks.getTaskRunHistory,
    },
  };
});

const finished = (run: TaskRun) =>
  run.status === "completed" || run.status === "stopped";

/** Sacrum's projectRunHistory over the in-memory server state. */
function serveHistory(
  includeCompleted: boolean,
  search: string | null,
  after: TaskRunHistoryCursor | null,
  limit: number | null
): { status: "ok"; data: TaskRunHistoryPage } {
  const query = (search ?? "").trim().toLowerCase();
  const matching = mocks.server.runs
    .map((run) => ({ run, task: mocks.server.tasks.get(run.task_id)! }))
    .filter(({ task }) => task && task.workflow_id && !task.archived)
    .filter(
      ({ run, task }) =>
        !query ||
        run.id.startsWith(query) ||
        task.id.startsWith(query) ||
        task.title.toLowerCase().includes(query)
    );
  const hidden = includeCompleted
    ? 0
    : matching.filter(({ run, task }) => !task.completed_at && finished(run))
        .length;
  const visible = matching
    .filter(
      ({ run, task }) =>
        includeCompleted || (!task.completed_at && !finished(run))
    )
    .sort(
      (a, b) =>
        b.run.updated_at!.localeCompare(a.run.updated_at!) ||
        b.run.id.localeCompare(a.run.id)
    )
    .filter(
      ({ run }) =>
        !after ||
        run.updated_at! < after.updated_at ||
        (run.updated_at === after.updated_at && run.id < after.id)
    );
  const size = limit ?? 50;
  return {
    status: "ok",
    data: {
      entries: visible.slice(0, size).map(({ run, task }) => ({
        task_run: run,
        task: {
          id: task.id,
          title: task.title,
          level: task.level ?? "task",
          parent_id: task.parent_id,
          workflow_id: task.workflow_id,
          workflow_name: task.workflow_name,
          completed_at: task.completed_at,
        },
      })),
      has_more: visible.length > size,
      hidden_completed_count: hidden,
    },
  };
}

const at = (minute: number) =>
  new Date(Date.UTC(2026, 10, 15, 6, minute)).toISOString();

function serverTask(overrides: Partial<Task>): Task {
  const task = createMockTask({
    workflow_id: "wf",
    workflow_name: "Delivery",
    ...overrides,
  });
  mocks.server.tasks.set(task.id, task);
  return task;
}

function serverRun(
  taskId: string,
  id: string,
  minute: number,
  status = "executing"
) {
  const run = createMockTaskRun({
    id,
    task_id: taskId,
    status: status as TaskRun["status"],
    updated_at: at(minute),
  });
  mocks.server.runs.push(run);
  return run;
}

const historyCalls = () => mocks.getTaskRunHistory.mock.calls;

function renderHistory(
  props: {
    showCompleted?: boolean;
    searchQuery?: string;
    enabled?: boolean;
  } = {}
) {
  return renderHook(
    (current: typeof props) =>
      useHistoryRuns({
        enabled: current.enabled ?? true,
        showCompleted: current.showCompleted ?? false,
        searchQuery: current.searchQuery ?? "",
      }),
    { initialProps: props }
  );
}

async function settled(result: { current: ReturnType<typeof useHistoryRuns> }) {
  await waitFor(() => expect(historyCalls().length).toBeGreaterThan(0));
  await waitFor(() => expect(result.current.rows.length).toBeGreaterThan(0));
}

describe("useHistoryRuns", () => {
  beforeEach(() => {
    queryClient.clear();
    mocks.server.runs = [];
    mocks.server.tasks = new Map();
    mocks.getTaskRunHistory.mockReset();
    mocks.getTaskRunHistory.mockImplementation(serveHistory);
    mocks.getTaskRuns.mockReset();

    const parser = serverTask({ id: "task-a", title: "Build parser" });
    const done = serverTask({
      id: "task-c",
      title: "Done",
      completed_at: "2026-01-01T00:00:00Z",
    });
    serverRun(parser.id, "run-active", 5);
    serverRun(parser.id, "run-failed", 4, "failed");
    serverRun(parser.id, "run-done", 3, "completed");
    serverRun(done.id, "run-c", 2, "failed");
    mocks.tasks = [...mocks.server.tasks.values()];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads one page however many workflow tasks the project has", async () => {
    for (let index = 0; index < 120; index += 1) {
      const task = serverTask({ id: `bulk-${index}`, title: `Bulk ${index}` });
      serverRun(task.id, `bulk-run-${index}`, 1);
    }
    mocks.tasks = [...mocks.server.tasks.values()];

    const { result } = renderHistory();
    await settled(result);

    expect(historyCalls()).toEqual([[false, null, null, 50]]);
    expect(mocks.getTaskRuns).not.toHaveBeenCalled();
  });

  it("reuses cached history when the sidebar unmounts and mounts again", async () => {
    const first = renderHistory();
    await settled(first.result);
    first.unmount();

    const second = renderHistory();
    expect(second.result.current.rows.map((row) => row.id)).toEqual([
      "run-active",
      "run-failed",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(historyCalls()).toHaveLength(1);
  });

  it("hides finished runs and completed tasks unless completed history is shown", async () => {
    const { result, rerender } = renderHistory();
    await settled(result);

    expect(result.current.rows.map((row) => row.id)).toEqual([
      "run-active",
      "run-failed",
    ]);
    expect(result.current.rows[0].label).toBe("Delivery run");
    expect(result.current.hiddenCompletedCount).toBe(1);

    rerender({ showCompleted: true });
    await waitFor(() => expect(result.current.rows).toHaveLength(4));
    expect(result.current.rows.map((row) => row.id)).toEqual([
      "run-active",
      "run-failed",
      "run-done",
      "run-c",
    ]);
    expect(historyCalls().at(-1)).toEqual([true, null, null, 50]);
  });

  it("does not let an active-run-only task snapshot stand in for history", async () => {
    const activeRun = mocks.server.runs[0];
    hydrateActiveTaskRunsFromTasks(
      [{ run_controls: { active_run: activeRun } as Task["run_controls"] }],
      getProjectScopeGeneration()
    );

    const { result } = renderHistory();
    await settled(result);

    expect(result.current.rows.map((row) => row.id)).toEqual([
      "run-active",
      "run-failed",
    ]);
  });

  it("loads older pages on demand from the cursor captured at fetch time", async () => {
    for (let index = 0; index < 60; index += 1)
      serverRun(
        "task-a",
        `older-${String(index).padStart(2, "0")}`,
        0,
        "failed"
      );

    const { result } = renderHistory();
    await settled(result);
    expect(result.current.rows).toHaveLength(50);
    expect(result.current.hasMore).toBe(true);

    const lastEntry = result.current.rows.at(-1)!.run;
    // A realtime update must not move where the next page starts.
    act(() =>
      upsertTaskRunInHistoryCache(
        { ...lastEntry, updated_at: at(30) },
        getProjectScopeGeneration()
      )
    );

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.rows).toHaveLength(62));
    expect(historyCalls()[1][2]).toEqual({
      updated_at: lastEntry.updated_at,
      id: lastEntry.id,
    });
    expect(new Set(result.current.rows.map((row) => row.id)).size).toBe(62);
    expect(result.current.hasMore).toBe(false);
  });

  it("applies realtime runs and status changes without refetching", async () => {
    const { result } = renderHistory();
    await settled(result);
    const generation = getProjectScopeGeneration();
    queryClient.setQueryData(
      queryKeys.tasks.list(generation, null),
      mocks.tasks
    );

    act(() =>
      upsertTaskRunInHistoryCache(
        createMockTaskRun({
          id: "run-new",
          task_id: "task-a",
          updated_at: at(9),
        }),
        generation
      )
    );
    await waitFor(() =>
      expect(result.current.rows.map((row) => row.id)).toContain("run-new")
    );

    act(() =>
      upsertTaskRunInHistoryCache(
        { ...mocks.server.runs[0], status: "completed", updated_at: at(10) },
        generation
      )
    );
    await waitFor(() =>
      expect(result.current.rows.map((row) => row.id)).not.toContain(
        "run-active"
      )
    );
    expect(result.current.hiddenCompletedCount).toBe(2);

    // An older snapshot never regresses a newer cached one.
    act(() =>
      upsertTaskRunInHistoryCache(
        { ...mocks.server.runs[1], status: "executing", updated_at: at(0) },
        generation
      )
    );
    expect(
      result.current.rows.find((row) => row.id === "run-failed")?.run.status
    ).toBe("failed");
    expect(historyCalls()).toHaveLength(1);
  });

  it("counts a run as hidden once, however many events follow", async () => {
    const { result } = renderHistory();
    await settled(result);
    const generation = getProjectScopeGeneration();
    const key = queryKeys.taskRunHistory.list(generation, false, "");
    const finishedRun = {
      ...mocks.server.runs[0],
      status: "completed" as const,
      updated_at: at(10),
    };

    act(() => upsertTaskRunInHistoryCache(finishedRun, generation));
    await waitFor(() => expect(result.current.hiddenCompletedCount).toBe(2));

    const before = queryClient.getQueryData(key);
    act(() => {
      // Duplicate delivery, a later field update, and an event for the run
      // the server already counted on fetch.
      upsertTaskRunInHistoryCache(finishedRun, generation);
      upsertTaskRunInHistoryCache(
        { ...finishedRun, updated_at: at(11) },
        generation
      );
      upsertTaskRunInHistoryCache(
        { ...mocks.server.runs[2], updated_at: at(12) },
        generation
      );
    });
    expect(result.current.hiddenCompletedCount).toBe(2);
    // Nothing visible changed, so the cache entry is untouched.
    expect(queryClient.getQueryData(key)).toBe(before);
  });

  it("leaves the cache untouched for a stale run event", async () => {
    const { result } = renderHistory();
    await settled(result);
    const generation = getProjectScopeGeneration();
    const key = queryKeys.taskRunHistory.list(generation, false, "");
    const before = queryClient.getQueryData(key);

    act(() => upsertTaskRunInHistoryCache(mocks.server.runs[0], generation));
    expect(queryClient.getQueryData(key)).toBe(before);
  });

  it("reconciles a run whose task no cache knows with one page request", async () => {
    const { result } = renderHistory();
    await settled(result);
    const stranger = serverTask({ id: "task-new", title: "Brand new" });
    const run = serverRun(stranger.id, "run-stranger", 20);

    act(() => upsertTaskRunInHistoryCache(run, getProjectScopeGeneration()));

    await waitFor(() =>
      expect(result.current.rows.map((row) => row.id)).toContain("run-stranger")
    );
    expect(historyCalls()).toHaveLength(2);
    expect(mocks.getTaskRuns).not.toHaveBeenCalled();
  });

  it("refetches loaded pages when the websocket reconnects", async () => {
    const { result } = renderHistory();
    await settled(result);
    serverRun("task-a", "run-missed", 30, "failed");

    act(() => reconcileTaskRunHistory(getProjectScopeGeneration()));

    await waitFor(() =>
      expect(result.current.rows.map((row) => row.id)).toContain("run-missed")
    );
    expect(historyCalls()).toHaveLength(2);
  });

  it("uses live task state for labels, completion and archival", async () => {
    const { result, rerender } = renderHistory();
    await settled(result);

    mocks.tasks = mocks.tasks.map((task) =>
      task.id === "task-a" ? { ...task, completed_at: at(40) } : task
    );
    rerender({});
    expect(result.current.rows).toEqual([]);

    mocks.tasks = mocks.tasks.map((task) =>
      task.id === "task-a"
        ? { ...task, completed_at: null, archived: true }
        : task
    );
    rerender({ showCompleted: false });
    expect(result.current.rows).toEqual([]);
  });

  it("drops a deleted task's runs from cached history", async () => {
    const { result } = renderHistory();
    await settled(result);

    act(() => removeTaskFromQueryCache("task-a", getProjectScopeGeneration()));

    await waitFor(() => expect(result.current.rows).toEqual([]));
  });

  it("searches on the server once typing settles", async () => {
    const { result, rerender } = renderHistory();
    await settled(result);
    vi.useFakeTimers();

    rerender({ searchQuery: "RUN-FAI" });
    // Loaded rows narrow at once while the server search waits.
    expect(result.current.rows.map((row) => row.id)).toEqual(["run-failed"]);
    expect(historyCalls()).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(HISTORY_SEARCH_DEBOUNCE_MS);
    });
    vi.useRealTimers();
    await waitFor(() => expect(historyCalls()).toHaveLength(2));
    expect(historyCalls()[1]).toEqual([false, "run-fai", null, 50]);
    expect(result.current.rows.map((row) => row.id)).toEqual(["run-failed"]);
  });

  it("never shows another project's history after a project switch", async () => {
    const { result, rerender } = renderHistory();
    await settled(result);

    let resolveNext!: (value: unknown) => void;
    mocks.getTaskRunHistory.mockImplementationOnce(
      () => new Promise((resolve) => (resolveNext = resolve))
    );
    act(() => resetProjectScopedStores());
    rerender({});

    expect(result.current.rows).toEqual([]);
    await waitFor(() => expect(historyCalls()).toHaveLength(2));
    resolveNext({
      status: "ok",
      data: { entries: [], has_more: false, hidden_completed_count: 0 },
    });
    await waitFor(() => expect(result.current.rows).toEqual([]));
  });

  it("lists nothing outside the current project", () => {
    const { result } = renderHistory({ enabled: false, showCompleted: true });
    expect(result.current.rows).toEqual([]);
    expect(historyCalls()).toHaveLength(0);
  });
});

describe("run history helpers", () => {
  it("treats completed and stopped runs as completed history", () => {
    expect(isCompletedRun({ status: "completed" })).toBe(true);
    expect(isCompletedRun({ status: "stopped" })).toBe(true);
    expect(isCompletedRun({ status: "failed" })).toBe(false);
    expect(isCompletedRun({ status: "waiting" })).toBe(false);
  });

  it("matches task title, task id and run id", () => {
    const run = { id: "abc12345-run", task_id: "def67890-task" };
    expect(runMatchesQuery(run, { title: "Fix parser" }, "parser")).toBe(true);
    expect(runMatchesQuery(run, { title: "Fix" }, "def678")).toBe(true);
    expect(runMatchesQuery(run, { title: "Fix" }, "abc1")).toBe(true);
    expect(runMatchesQuery(run, { title: "Fix" }, "zzz")).toBe(false);
  });
});
