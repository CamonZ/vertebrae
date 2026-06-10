import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  replaceTaskRunControlsInQueryCache,
  queryClient,
} from "../../../query";
import { resetProjectScopedStores } from "../../../stores/projectScopedStores";
import {
  createMockTask,
  createMockTaskRun,
  createMockTaskRunControls,
} from "../../../test/test-utils";

type EventCallback = () => void;

const { mockListReady, eventListeners, mockEvents, emitEvent } = vi.hoisted(
  () => {
    const listeners: Record<string, EventCallback[]> = {};
    const listReady = vi.fn();

    function createEventListener(eventName: string) {
      return {
        listen: vi.fn((callback: EventCallback) => {
          listeners[eventName] = listeners[eventName] ?? [];
          listeners[eventName].push(callback);
          return Promise.resolve(() => {
            const index = listeners[eventName].indexOf(callback);
            if (index > -1) listeners[eventName].splice(index, 1);
          });
        }),
      };
    }

    return {
      mockListReady: listReady,
      eventListeners: listeners,
      mockEvents: {
        taskChangedEvent: createEventListener("taskChanged"),
        taskRunChangedEvent: createEventListener("taskRunChanged"),
        taskRunStepChangedEvent: createEventListener("taskRunStepChanged"),
        taskStepChangedEvent: createEventListener("taskStepChanged"),
      },
      emitEvent: (eventName: string) => {
        (listeners[eventName] ?? []).forEach((callback) => callback());
      },
    };
  }
);

vi.mock("../../../bindings", () => ({
  commands: {
    listReady: (...args: unknown[]) => mockListReady(...args),
  },
  events: mockEvents,
}));

import { useRunConsoleTasks } from "./useRunConsoleTasks";

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children);

describe("useRunConsoleTasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProjectScopedStores();
    for (const key of Object.keys(eventListeners)) eventListeners[key] = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads the ready feed through TanStack Query", async () => {
    const task = createMockTask({ id: "ready-1", title: "Ready One" });
    mockListReady.mockResolvedValue({ status: "ok", data: [task] });

    const { result } = renderHook(() => useRunConsoleTasks(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.tasks).toEqual([task]);
    expect(mockListReady).toHaveBeenCalledTimes(1);
  });

  it("reflects run-control cache patches without waiting for a refetch", async () => {
    const task = createMockTask({ id: "ready-1", run_controls: null });
    const activeRun = createMockTaskRun({
      id: "run-active",
      task_id: task.id,
      status: "executing",
    });
    const runControls = createMockTaskRunControls(activeRun);
    mockListReady.mockResolvedValue({ status: "ok", data: [task] });

    const { result } = renderHook(() => useRunConsoleTasks(), { wrapper });

    await waitFor(() => {
      expect(result.current.tasks).toEqual([task]);
    });

    act(() => {
      replaceTaskRunControlsInQueryCache(task.id, runControls);
    });

    await waitFor(() => {
      expect(result.current.tasks[0].run_controls).toEqual(runControls);
    });
    expect(mockListReady).toHaveBeenCalledTimes(1);
  });

  it("debounces realtime events into a ready-feed invalidation", async () => {
    const before = createMockTask({ id: "ready-1", title: "Before" });
    const after = createMockTask({ id: "ready-1", title: "After" });
    mockListReady
      .mockResolvedValueOnce({ status: "ok", data: [before] })
      .mockResolvedValueOnce({ status: "ok", data: [after] });

    const { result } = renderHook(() => useRunConsoleTasks(), { wrapper });

    await waitFor(() => {
      expect(result.current.tasks[0]?.title).toBe("Before");
    });

    act(() => {
      emitEvent("taskRunChanged");
    });

    await waitFor(() => {
      expect(result.current.tasks[0]?.title).toBe("After");
    });
    expect(mockListReady).toHaveBeenCalledTimes(2);
  });
});
