import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const mockListTasks = vi.fn();
type Handler = (event: { payload: unknown }) => void;
let capturedHandler: Handler | null = null;
const mockListen = vi.fn((handler: Handler) => {
  capturedHandler = handler;
  return Promise.resolve(() => {});
});

vi.mock("../bindings", () => ({
  commands: {
    listTasks: (...args: unknown[]) => mockListTasks(...args),
  },
  events: {
    taskChangedEvent: {
      listen: (handler: Handler) => mockListen(handler),
    },
  },
}));

import { useStepTasks } from "./useStepTasks";
import { createMockTask } from "../test/test-utils";

function emit(payload: {
  task_id: string;
  change_type: "Created" | "Updated" | "Deleted" | "StatusChanged";
  task: ReturnType<typeof createMockTask> | null;
}) {
  if (!capturedHandler) throw new Error("handler not registered");
  act(() => {
    capturedHandler!({ payload });
  });
}

describe("useStepTasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandler = null;
  });

  it("returns an empty array and does not fetch when stepId is null", async () => {
    mockListTasks.mockResolvedValue({ status: "ok", data: [] });

    const { result } = renderHook(() => useStepTasks(null));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockListTasks).not.toHaveBeenCalled();
    expect(result.current.tasks).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("fetches tasks for the given step and exposes them", async () => {
    const task1 = createMockTask({
      id: "t-1",
      title: "Task 1",
      current_step_id: "step-A",
    });
    const task2 = createMockTask({
      id: "t-2",
      title: "Task 2",
      current_step_id: "step-A",
    });
    mockListTasks.mockResolvedValue({ status: "ok", data: [task1, task2] });

    const { result } = renderHook(() => useStepTasks("step-A"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockListTasks).toHaveBeenCalledTimes(1);
    const callArg = mockListTasks.mock.calls[0][0] as { step_id: string | null };
    expect(callArg.step_id).toBe("step-A");
    expect(result.current.tasks).toHaveLength(2);
    expect(result.current.tasks.map((t) => t.id)).toEqual(["t-1", "t-2"]);
  });

  it("returns the empty list when the server reports zero tasks", async () => {
    mockListTasks.mockResolvedValue({ status: "ok", data: [] });

    const { result } = renderHook(() => useStepTasks("step-empty"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.tasks).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("surfaces fetch errors without populating tasks", async () => {
    mockListTasks.mockResolvedValue({
      status: "error",
      error: { message: "boom" },
    });

    const { result } = renderHook(() => useStepTasks("step-err"));

    await waitFor(() => {
      expect(result.current.error).toBe("boom");
    });
    expect(result.current.tasks).toEqual([]);
  });

  it("refetches when the stepId changes", async () => {
    mockListTasks.mockImplementation((filter: { step_id: string | null }) => {
      const t = createMockTask({
        id: `task-for-${filter.step_id}`,
        current_step_id: filter.step_id ?? null,
      });
      return Promise.resolve({ status: "ok", data: [t] });
    });

    const { result, rerender } = renderHook(
      ({ stepId }: { stepId: string | null }) => useStepTasks(stepId),
      { initialProps: { stepId: "step-A" } },
    );

    await waitFor(() => {
      expect(result.current.tasks.map((t) => t.id)).toEqual(["task-for-step-A"]);
    });

    rerender({ stepId: "step-B" });

    await waitFor(() => {
      expect(result.current.tasks.map((t) => t.id)).toEqual(["task-for-step-B"]);
    });

    expect(mockListTasks).toHaveBeenCalledTimes(2);
  });

  it("upserts a task that moves into the selected step via WS event", async () => {
    mockListTasks.mockResolvedValue({ status: "ok", data: [] });

    const { result } = renderHook(() => useStepTasks("step-A"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.tasks).toHaveLength(0);

    const incoming = createMockTask({
      id: "t-new",
      title: "Just Arrived",
      current_step_id: "step-A",
    });

    emit({ task_id: "t-new", change_type: "Updated", task: incoming });

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(1);
    });
    expect(result.current.tasks[0].id).toBe("t-new");
    expect(result.current.tasks[0].title).toBe("Just Arrived");
  });

  it("removes a task whose current_step_id moves away from the selected step", async () => {
    const task = createMockTask({
      id: "t-leaving",
      current_step_id: "step-A",
    });
    mockListTasks.mockResolvedValue({ status: "ok", data: [task] });

    const { result } = renderHook(() => useStepTasks("step-A"));

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(1);
    });

    const moved = { ...task, current_step_id: "step-B" };
    emit({ task_id: "t-leaving", change_type: "Updated", task: moved });

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(0);
    });
  });

  it("replaces a task in place when it stays at the selected step but updates", async () => {
    const original = createMockTask({
      id: "t-stays",
      title: "Original Title",
      current_step_id: "step-A",
    });
    mockListTasks.mockResolvedValue({ status: "ok", data: [original] });

    const { result } = renderHook(() => useStepTasks("step-A"));

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(1);
    });

    const updated = { ...original, title: "Renamed" };
    emit({ task_id: "t-stays", change_type: "Updated", task: updated });

    await waitFor(() => {
      expect(result.current.tasks[0].title).toBe("Renamed");
    });
    expect(result.current.tasks).toHaveLength(1);
  });

  it("removes a task when a Deleted event matches a known task", async () => {
    const task = createMockTask({ id: "t-doomed", current_step_id: "step-A" });
    mockListTasks.mockResolvedValue({ status: "ok", data: [task] });

    const { result } = renderHook(() => useStepTasks("step-A"));

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(1);
    });

    emit({ task_id: "t-doomed", change_type: "Deleted", task: null });

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(0);
    });
  });

  it("ignores WS events that target a different step", async () => {
    const own = createMockTask({ id: "t-own", current_step_id: "step-A" });
    mockListTasks.mockResolvedValue({ status: "ok", data: [own] });

    const { result } = renderHook(() => useStepTasks("step-A"));

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(1);
    });

    const unrelated = createMockTask({
      id: "t-other",
      current_step_id: "step-Z",
    });
    emit({ task_id: "t-other", change_type: "Updated", task: unrelated });

    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.tasks[0].id).toBe("t-own");
  });
});
