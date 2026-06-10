import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { useWorkflowStore } from "../stores/workflowStore";
import { resetProjectScopedStores } from "../stores/projectScopedStores";
import {
  queryClient,
  removeWorkflowFromQueryCache,
  upsertWorkflowInQueryCache,
} from "../query";

const mockListWorkflows = vi.fn();

vi.mock("../bindings", () => ({
  commands: {
    listWorkflows: (...args: unknown[]) => mockListWorkflows(...args),
  },
}));

import { useWorkflows } from "./useWorkflows";
import type { Workflow } from "../bindings";
import { createMockWorkflow } from "../test/test-utils";

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children);

describe("useWorkflows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkflowStore.setState({
      workflows: [],
      currentWorkflow: null,
      isLoading: false,
    });
  });

  it("returns workflows from the query cache and syncs the Zustand bridge", async () => {
    const wf1 = createMockWorkflow({ id: "wf-1", name: "Alpha" });
    mockListWorkflows.mockResolvedValue({ status: "ok", data: [wf1] });

    const { result } = renderHook(() => useWorkflows(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.workflows).toHaveLength(1);
    expect(result.current.workflows[0].id).toBe("wf-1");
    expect(result.current.workflows[0].name).toBe("Alpha");

    const storeWorkflows = useWorkflowStore.getState().workflows;
    expect(storeWorkflows).toHaveLength(1);
    expect(storeWorkflows[0].id).toBe("wf-1");
  });

  it("reflects query cache mutations (e.g. from WebSocket upserts)", async () => {
    const wf1 = createMockWorkflow({ id: "wf-1", name: "Original" });
    mockListWorkflows.mockResolvedValue({ status: "ok", data: [wf1] });

    const { result } = renderHook(() => useWorkflows(), { wrapper });

    await waitFor(() => {
      expect(result.current.workflows).toHaveLength(1);
    });

    const wf2 = createMockWorkflow({ id: "wf-2", name: "WebSocket Workflow" });
    act(() => {
      upsertWorkflowInQueryCache(wf2);
    });

    await waitFor(() => {
      expect(result.current.workflows).toHaveLength(2);
    });
    expect(result.current.workflows.map((w: Workflow) => w.id)).toContain(
      "wf-2"
    );
    expect(
      result.current.workflows.find((w: Workflow) => w.id === "wf-2")?.name
    ).toBe("WebSocket Workflow");
  });

  it("reflects query cache removals (e.g. from WebSocket deletions)", async () => {
    const wf1 = createMockWorkflow({ id: "wf-1", name: "Will Remove" });
    const wf2 = createMockWorkflow({ id: "wf-2", name: "Will Stay" });
    mockListWorkflows.mockResolvedValue({ status: "ok", data: [wf1, wf2] });

    const { result } = renderHook(() => useWorkflows(), { wrapper });

    await waitFor(() => {
      expect(result.current.workflows).toHaveLength(2);
    });

    act(() => {
      removeWorkflowFromQueryCache("wf-1");
    });

    await waitFor(() => {
      expect(result.current.workflows).toHaveLength(1);
    });
    expect(result.current.workflows[0].id).toBe("wf-2");
    expect(result.current.workflows[0].name).toBe("Will Stay");
  });

  it("sets error state on fetch failure without corrupting the store", async () => {
    const existing = createMockWorkflow({
      id: "wf-existing",
      name: "Existing",
    });
    useWorkflowStore.setState({ workflows: [existing] });

    mockListWorkflows.mockResolvedValue({
      status: "error",
      error: { message: "Server error" },
    });

    const { result } = renderHook(() => useWorkflows(), { wrapper });

    await waitFor(() => {
      expect(result.current.error).toBe("Server error");
    });

    // Store should still have the pre-existing workflow
    expect(useWorkflowStore.getState().workflows).toHaveLength(1);
    expect(useWorkflowStore.getState().workflows[0].id).toBe("wf-existing");
  });

  it("replaces stale store data with fresh fetch results", async () => {
    const stale = createMockWorkflow({ id: "wf-stale", name: "Stale" });
    useWorkflowStore.setState({ workflows: [stale] });

    const fresh = createMockWorkflow({ id: "wf-fresh", name: "Fresh" });
    mockListWorkflows.mockResolvedValue({ status: "ok", data: [fresh] });

    const { result } = renderHook(() => useWorkflows(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.workflows).toHaveLength(1);
    expect(result.current.workflows[0].id).toBe("wf-fresh");
    expect(result.current.workflows[0].name).toBe("Fresh");
  });

  it("ignores stale fetch results after project-scoped stores reset", async () => {
    let resolveFetch!: (value: { status: "ok"; data: Workflow[] }) => void;
    mockListWorkflows.mockResolvedValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );
    mockListWorkflows.mockResolvedValueOnce({ status: "ok", data: [] });

    const { result } = renderHook(() => useWorkflows(), { wrapper });

    await waitFor(() => {
      expect(mockListWorkflows).toHaveBeenCalledTimes(1);
    });

    act(() => {
      resetProjectScopedStores();
    });

    const staleWorkflow = createMockWorkflow({
      id: "old-project-workflow",
      name: "Old Project Workflow",
    });
    await act(async () => {
      resolveFetch({ status: "ok", data: [staleWorkflow] });
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(useWorkflowStore.getState().workflows).toEqual([]);
    expect(result.current.workflows).toEqual([]);
  });

  it("ignores stale fetch errors after project-scoped stores reset", async () => {
    let resolveFetch!: (value: {
      status: "error";
      error: { message: string };
    }) => void;
    mockListWorkflows.mockResolvedValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );
    mockListWorkflows.mockResolvedValueOnce({ status: "ok", data: [] });

    const { result } = renderHook(() => useWorkflows(), { wrapper });

    await waitFor(() => {
      expect(mockListWorkflows).toHaveBeenCalledTimes(1);
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
});
