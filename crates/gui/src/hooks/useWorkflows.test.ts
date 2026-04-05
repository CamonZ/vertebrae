import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useWorkflowStore } from "../stores/workflowStore";

const mockListWorkflows = vi.fn();

vi.mock("../bindings", () => ({
  commands: {
    listWorkflows: (...args: unknown[]) => mockListWorkflows(...args),
  },
}));

import { useWorkflows } from "./useWorkflows";
import type { Workflow } from "../bindings";
import { createMockWorkflow } from "../test/test-utils";

describe("useWorkflows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkflowStore.setState({ workflows: [], currentWorkflow: null, isLoading: false });
  });

  it("returns workflows from the Zustand store, not a local copy", async () => {
    const wf1 = createMockWorkflow({ id: "wf-1", name: "Alpha" });
    mockListWorkflows.mockResolvedValue({ status: "ok", data: [wf1] });

    const { result } = renderHook(() => useWorkflows());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.workflows).toHaveLength(1);
    expect(result.current.workflows[0].id).toBe("wf-1");
    expect(result.current.workflows[0].name).toBe("Alpha");

    // The hook's workflows should be the exact same reference as the store's
    const storeWorkflows = useWorkflowStore.getState().workflows;
    expect(result.current.workflows).toBe(storeWorkflows);
  });

  it("reflects external store mutations (e.g. from WebSocket upserts)", async () => {
    const wf1 = createMockWorkflow({ id: "wf-1", name: "Original" });
    mockListWorkflows.mockResolvedValue({ status: "ok", data: [wf1] });

    const { result } = renderHook(() => useWorkflows());

    await waitFor(() => {
      expect(result.current.workflows).toHaveLength(1);
    });

    // Simulate a WebSocket-driven store mutation
    const wf2 = createMockWorkflow({ id: "wf-2", name: "WebSocket Workflow" });
    act(() => {
      useWorkflowStore.getState().upsertWorkflow(wf2);
    });

    expect(result.current.workflows).toHaveLength(2);
    expect(result.current.workflows.map((w: Workflow) => w.id)).toContain("wf-2");
    expect(result.current.workflows.find((w: Workflow) => w.id === "wf-2")?.name).toBe("WebSocket Workflow");
  });

  it("reflects store removals (e.g. from WebSocket deletions)", async () => {
    const wf1 = createMockWorkflow({ id: "wf-1", name: "Will Remove" });
    const wf2 = createMockWorkflow({ id: "wf-2", name: "Will Stay" });
    mockListWorkflows.mockResolvedValue({ status: "ok", data: [wf1, wf2] });

    const { result } = renderHook(() => useWorkflows());

    await waitFor(() => {
      expect(result.current.workflows).toHaveLength(2);
    });

    act(() => {
      useWorkflowStore.getState().removeWorkflow("wf-1");
    });

    expect(result.current.workflows).toHaveLength(1);
    expect(result.current.workflows[0].id).toBe("wf-2");
    expect(result.current.workflows[0].name).toBe("Will Stay");
  });

  it("sets error state on fetch failure without corrupting the store", async () => {
    const existing = createMockWorkflow({ id: "wf-existing", name: "Existing" });
    useWorkflowStore.setState({ workflows: [existing] });

    mockListWorkflows.mockResolvedValue({ status: "error", error: { message: "Server error" } });

    const { result } = renderHook(() => useWorkflows());

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

    const { result } = renderHook(() => useWorkflows());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.workflows).toHaveLength(1);
    expect(result.current.workflows[0].id).toBe("wf-fresh");
    expect(result.current.workflows[0].name).toBe("Fresh");
  });
});
