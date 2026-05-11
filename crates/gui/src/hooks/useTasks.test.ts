import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useTaskStore } from "../stores/taskStore";
import { resetProjectScopedStores } from "../stores/projectScopedStores";

const mockListTasks = vi.fn();

vi.mock("../bindings", () => ({
  commands: {
    listTasks: (...args: unknown[]) => mockListTasks(...args),
  },
}));

import { useTasks } from "./useTasks";
import type { Task, TaskFilterOptions } from "../bindings";
import { createMockTask } from "../test/test-utils";

describe("useTasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTaskStore.setState({
      tasks: [],
      selectedTaskId: null,
      selectedTask: null,
      isLoading: false,
    });
  });

  it("returns tasks from the Zustand store, not a local copy", async () => {
    const task1 = createMockTask({ id: "t-1", title: "Store Task" });
    mockListTasks.mockResolvedValue({ status: "ok", data: [task1] });

    const { result } = renderHook(() => useTasks());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.tasks[0].id).toBe("t-1");
    expect(result.current.tasks[0].title).toBe("Store Task");

    // Verify the store contains the same data
    const storeTasks = useTaskStore.getState().tasks;
    expect(storeTasks).toHaveLength(1);
    expect(storeTasks[0].id).toBe("t-1");

    // The hook's tasks reference should be the same as the store's
    expect(result.current.tasks).toBe(storeTasks);
  });

  it("reflects external store mutations (e.g. from WebSocket upserts)", async () => {
    const task1 = createMockTask({ id: "t-1", title: "Original" });
    mockListTasks.mockResolvedValue({ status: "ok", data: [task1] });

    const { result } = renderHook(() => useTasks());

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(1);
    });

    // Simulate an external store mutation (like a WebSocket-driven upsert)
    const newTask = createMockTask({ id: "t-2", title: "WebSocket Task" });
    act(() => {
      useTaskStore.getState().upsertTask(newTask);
    });

    // The hook should immediately reflect the store change
    expect(result.current.tasks).toHaveLength(2);
    expect(result.current.tasks.map((t: Task) => t.id)).toContain("t-2");
    expect(result.current.tasks.find((t: Task) => t.id === "t-2")?.title).toBe(
      "WebSocket Task"
    );
  });

  it("preserves tasks upserted during fetch flight", async () => {
    // The fetch will return [t-1], but during the fetch, t-2 is upserted
    const task1 = createMockTask({ id: "t-1", title: "Fetched" });

    mockListTasks.mockImplementation(async () => {
      // Simulate a WebSocket upsert arriving during the fetch
      const wsTask = createMockTask({ id: "t-2", title: "During Flight" });
      useTaskStore.getState().upsertTask(wsTask);
      return { status: "ok", data: [task1] };
    });

    const { result } = renderHook(() => useTasks());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Both the fetched task and the in-flight WebSocket task should be present
    const ids = result.current.tasks.map((t: Task) => t.id);
    expect(ids).toContain("t-1");
    expect(ids).toContain("t-2");
  });

  it("ignores stale fetch results after project-scoped stores reset", async () => {
    let resolveFetch!: (value: { status: "ok"; data: Task[] }) => void;
    mockListTasks.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );

    const { result } = renderHook(() => useTasks());

    await waitFor(() => {
      expect(mockListTasks).toHaveBeenCalledTimes(1);
    });

    act(() => {
      resetProjectScopedStores();
    });

    const staleTask = createMockTask({
      id: "old-project-task",
      title: "Old Project Task",
    });
    await act(async () => {
      resolveFetch({ status: "ok", data: [staleTask] });
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(useTaskStore.getState().tasks).toEqual([]);
    expect(result.current.tasks).toEqual([]);
  });

  it("ignores stale fetch errors after project-scoped stores reset", async () => {
    let resolveFetch!: (value: {
      status: "error";
      error: { message: string };
    }) => void;
    mockListTasks.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );

    const { result } = renderHook(() => useTasks());

    await waitFor(() => {
      expect(mockListTasks).toHaveBeenCalledTimes(1);
    });

    act(() => {
      resetProjectScopedStores();
    });

    await act(async () => {
      resolveFetch({
        status: "error",
        error: { message: "old project error" },
      });
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBeNull();
  });

  it("passes filter options to the listTasks command", async () => {
    mockListTasks.mockResolvedValue({ status: "ok", data: [] });

    const filter: TaskFilterOptions = {
      step_names: null,
      levels: ["epic"],
      tags: null,
      root_only: null,
      children_of: null,
      include_done: false,
      search: null,
      workflow_id: null,
      step_id: null,
    };

    renderHook(() => useTasks(filter));

    await waitFor(() => {
      expect(mockListTasks).toHaveBeenCalledWith(filter);
    });
  });

  it("sets error state on fetch failure without corrupting the store", async () => {
    // Pre-seed the store with existing tasks
    const existing = createMockTask({ id: "t-existing", title: "Existing" });
    useTaskStore.setState({ tasks: [existing] });

    mockListTasks.mockResolvedValue({
      status: "error",
      error: { message: "Network error" },
    });

    const { result } = renderHook(() => useTasks());

    await waitFor(() => {
      expect(result.current.error).toBe("Network error");
    });

    // Store should still have the pre-existing task (not wiped by the error)
    expect(useTaskStore.getState().tasks).toHaveLength(1);
    expect(useTaskStore.getState().tasks[0].id).toBe("t-existing");
  });

  it("drops pre-existing store tasks that are absent from a fresh project fetch", async () => {
    const preExisting = createMockTask({ id: "t-pre", title: "Pre-existing" });
    useTaskStore.setState({ tasks: [preExisting] });

    const fresh = createMockTask({ id: "t-fresh", title: "Fresh" });
    mockListTasks.mockResolvedValue({ status: "ok", data: [fresh] });

    const { result } = renderHook(() => useTasks());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const ids = result.current.tasks.map((t: Task) => t.id);
    expect(ids).toContain("t-fresh");
    expect(ids).not.toContain("t-pre");
    expect(result.current.tasks).toHaveLength(1);
  });
});
