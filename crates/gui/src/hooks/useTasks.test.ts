import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  getProjectScopeGeneration,
  resetProjectScopedStores,
} from "../stores/projectScopedStores";
import { queryClient, queryKeys, upsertTaskInQueryCache } from "../query";

const mockListTasks = vi.fn();

vi.mock("../bindings", () => ({
  commands: {
    listTasks: (...args: unknown[]) => mockListTasks(...args),
  },
}));

import { useTasks } from "./useTasks";
import type { Task, TaskFilterOptions } from "../bindings";
import { createMockTask } from "../test/test-utils";

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children);

describe("useTasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns tasks from the query cache", async () => {
    const task1 = createMockTask({ id: "t-1", title: "Query Task" });
    mockListTasks.mockResolvedValue({ status: "ok", data: [task1] });

    const { result } = renderHook(() => useTasks(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.tasks[0].id).toBe("t-1");
    expect(result.current.tasks[0].title).toBe("Query Task");
  });

  it("reflects query cache mutations (e.g. from WebSocket upserts)", async () => {
    const task1 = createMockTask({ id: "t-1", title: "Original" });
    mockListTasks.mockResolvedValue({ status: "ok", data: [task1] });

    const { result } = renderHook(() => useTasks(), { wrapper });

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(1);
    });

    const newTask = createMockTask({ id: "t-2", title: "WebSocket Task" });
    act(() => {
      upsertTaskInQueryCache(newTask);
    });

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(2);
    });
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
      upsertTaskInQueryCache(wsTask);
      return { status: "ok", data: [task1] };
    });

    const { result } = renderHook(() => useTasks(), { wrapper });

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
    mockListTasks.mockResolvedValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );
    mockListTasks.mockResolvedValueOnce({ status: "ok", data: [] });

    const { result } = renderHook(() => useTasks(), { wrapper });

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

    expect(result.current.tasks).toEqual([]);
  });

  it("ignores stale fetch errors after project-scoped stores reset", async () => {
    let resolveFetch!: (value: {
      status: "error";
      error: { message: string };
    }) => void;
    mockListTasks.mockResolvedValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );
    mockListTasks.mockResolvedValueOnce({ status: "ok", data: [] });

    const { result } = renderHook(() => useTasks(), { wrapper });

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
      search: null,
      workflow_id: null,
      step_id: null,
    };

    renderHook(() => useTasks(filter), { wrapper });

    await waitFor(() => {
      expect(mockListTasks).toHaveBeenCalledWith(filter);
    });
  });

  it("sets error state on fetch failure without returning stale store data", async () => {
    mockListTasks.mockResolvedValue({
      status: "error",
      error: { message: "Network error" },
    });

    const { result } = renderHook(() => useTasks(), { wrapper });

    await waitFor(() => {
      expect(result.current.error).toBe("Network error");
    });

    expect(result.current.tasks).toEqual([]);
  });

  it("drops pre-existing query tasks that are absent from a fresh project fetch", async () => {
    const preExisting = createMockTask({ id: "t-pre", title: "Pre-existing" });
    upsertTaskInQueryCache(preExisting);
    await queryClient.invalidateQueries({
      queryKey: queryKeys.tasks.lists(getProjectScopeGeneration()),
    });

    const fresh = createMockTask({ id: "t-fresh", title: "Fresh" });
    mockListTasks.mockResolvedValue({ status: "ok", data: [fresh] });

    const { result } = renderHook(() => useTasks(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const ids = result.current.tasks.map((t: Task) => t.id);
    expect(ids).toContain("t-fresh");
    expect(ids).not.toContain("t-pre");
    expect(result.current.tasks).toHaveLength(1);
  });
});
