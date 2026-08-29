import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

type EventCallback = (event: { payload: Record<string, unknown> }) => void;

const { mockEvents, eventListeners, emitEvent } = vi.hoisted(() => {
  const listeners: Record<string, EventCallback[]> = {};

  function createEventListener(eventName: string) {
    return {
      listen: vi.fn((callback: EventCallback) => {
        listeners[eventName] = listeners[eventName] || [];
        listeners[eventName].push(callback);
        return Promise.resolve(() => {
          const idx = listeners[eventName].indexOf(callback);
          if (idx > -1) listeners[eventName].splice(idx, 1);
        });
      }),
    };
  }

  return {
    mockEvents: {
      sessionLogCreatedEvent: createEventListener("sessionLogCreated"),
      sessionLogUpdatedEvent: createEventListener("sessionLogUpdated"),
    },
    eventListeners: listeners,
    emitEvent: (eventName: string, payload: Record<string, unknown>) => {
      const callbacks = listeners[eventName] || [];
      callbacks.forEach((callback) => callback({ payload }));
    },
  };
});

vi.mock("../bindings", () => ({
  events: mockEvents,
}));

import { useSessionLogChangeListener } from "./useSessionLogChangeListener";
import { useNotificationStore, useSessionLogStore } from "../stores";

describe("useSessionLogChangeListener", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    Object.keys(eventListeners).forEach((key) => {
      eventListeners[key] = [];
    });
    // Reset stores between tests
    useSessionLogStore.setState({ logsByExecutionId: {} });
    useNotificationStore.getState().clearNotifications();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function flushQueuedEvents() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
  }

  it("calls appendLog when a created event has session_log", async () => {
    renderHook(() => useSessionLogChangeListener());

    // Wait for the listener to be registered
    await act(async () => {
      await Promise.resolve();
    });

    const sessionLog = {
      id: "log-abc123",
      step_execution_id: "exec-001",
      content: "Step started execution",
      created_at: "2026-03-17T10:00:00Z",
    };

    act(() => {
      emitEvent("sessionLogCreated", {
        log_id: "log-abc123",
        step_execution_id: "exec-001",
        session_log: sessionLog,
      });
    });

    await flushQueuedEvents();

    const logs = useSessionLogStore.getState().logsByExecutionId["exec-001"];
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual(sessionLog);
    expect(logs[0].id).toBe("log-abc123");
    expect(logs[0].content).toBe("Step started execution");
    expect(logs[0].step_execution_id).toBe("exec-001");
  });

  it("does not call appendLog when a created event has null session_log", async () => {
    renderHook(() => useSessionLogChangeListener());

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      emitEvent("sessionLogCreated", {
        log_id: "log-null01",
        step_execution_id: "exec-002",
        session_log: null,
      });
    });

    const logs = useSessionLogStore.getState().logsByExecutionId["exec-002"];
    expect(logs).toBeUndefined();
  });

  it("does not fire when disabled (enabled: false)", async () => {
    renderHook(() => useSessionLogChangeListener({ enabled: false }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockEvents.sessionLogCreatedEvent.listen).not.toHaveBeenCalled();
    expect(mockEvents.sessionLogUpdatedEvent.listen).not.toHaveBeenCalled();

    // Emit an event anyway to be thorough
    act(() => {
      emitEvent("sessionLogCreated", {
        log_id: "log-disabled",
        step_execution_id: "exec-003",
        session_log: {
          id: "log-disabled",
          step_execution_id: "exec-003",
          content: "Should not appear",
          created_at: "2026-03-17T10:00:00Z",
        },
      });
    });

    const logs = useSessionLogStore.getState().logsByExecutionId["exec-003"];
    expect(logs).toBeUndefined();
  });

  it("appends to correct execution bucket with different step_execution_ids", async () => {
    renderHook(() => useSessionLogChangeListener());

    await act(async () => {
      await Promise.resolve();
    });

    const log1 = {
      id: "log-a1",
      step_execution_id: "exec-alpha",
      content: "Alpha log entry",
      created_at: "2026-03-17T10:00:00Z",
    };

    const log2 = {
      id: "log-b1",
      step_execution_id: "exec-beta",
      content: "Beta log entry",
      created_at: "2026-03-17T10:01:00Z",
    };

    act(() => {
      emitEvent("sessionLogCreated", {
        log_id: "log-a1",
        step_execution_id: "exec-alpha",
        session_log: log1,
      });
    });

    act(() => {
      emitEvent("sessionLogCreated", {
        log_id: "log-b1",
        step_execution_id: "exec-beta",
        session_log: log2,
      });
    });

    await flushQueuedEvents();

    const alphaLogs =
      useSessionLogStore.getState().logsByExecutionId["exec-alpha"];
    const betaLogs =
      useSessionLogStore.getState().logsByExecutionId["exec-beta"];

    expect(alphaLogs).toHaveLength(1);
    expect(alphaLogs[0].id).toBe("log-a1");
    expect(alphaLogs[0].content).toBe("Alpha log entry");

    expect(betaLogs).toHaveLength(1);
    expect(betaLogs[0].id).toBe("log-b1");
    expect(betaLogs[0].content).toBe("Beta log entry");
  });

  it("upserts updated events without growing or reordering existing logs", async () => {
    renderHook(() => useSessionLogChangeListener());

    await act(async () => {
      await Promise.resolve();
    });

    const originalLog = {
      id: "log-ephemeral-old",
      logical_key: "thinking:sess-1",
      step_execution_id: "exec-001",
      content: "old snapshot",
      created_at: "2026-03-17T10:00:00Z",
    };
    const durableLog = {
      id: "log-durable",
      step_execution_id: "exec-001",
      content: "durable row",
      created_at: "2026-03-17T10:01:00Z",
    };
    const updatedLog = {
      id: "log-ephemeral-new",
      logical_key: "thinking:sess-1",
      step_execution_id: "exec-001",
      content: "new snapshot",
      created_at: "2026-03-17T10:02:00Z",
    };

    useSessionLogStore.getState().setLogs("exec-001", [originalLog, durableLog]);

    act(() => {
      emitEvent("sessionLogUpdated", {
        log_id: "log-ephemeral-new",
        step_execution_id: "exec-001",
        session_log: updatedLog,
      });
    });

    await flushQueuedEvents();

    const logs = useSessionLogStore.getState().logsByExecutionId["exec-001"];
    expect(logs).toHaveLength(2);
    expect(logs[0]).toEqual(updatedLog);
    expect(logs[1]).toEqual(durableLog);
  });

  it("inserts updated events when the created event was missed", async () => {
    renderHook(() => useSessionLogChangeListener());

    await act(async () => {
      await Promise.resolve();
    });

    const updatedLog = {
      id: "log-first-seen-as-update",
      logical_key: "thinking:sess-2",
      step_execution_id: "exec-002",
      content: "first snapshot seen by GUI",
      created_at: "2026-03-17T10:02:00Z",
    };

    act(() => {
      emitEvent("sessionLogUpdated", {
        log_id: "log-first-seen-as-update",
        step_execution_id: "exec-002",
        session_log: updatedLog,
      });
    });

    await flushQueuedEvents();

    const logs = useSessionLogStore.getState().logsByExecutionId["exec-002"];
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual(updatedLog);
  });

  it("does not fire any toasts", async () => {
    renderHook(() => useSessionLogChangeListener());

    await act(async () => {
      await Promise.resolve();
    });

    const sessionLog = {
      id: "log-no-toast",
      step_execution_id: "exec-toast",
      content: "No toast should appear",
      created_at: "2026-03-17T10:00:00Z",
    };

    act(() => {
      emitEvent("sessionLogCreated", {
        log_id: "log-no-toast",
        step_execution_id: "exec-toast",
        session_log: sessionLog,
      });
    });

    await flushQueuedEvents();

    const notifications = useNotificationStore.getState().notifications;
    expect(notifications).toHaveLength(0);
  });

  it("cleans up listener on unmount", async () => {
    const { unmount } = renderHook(() => useSessionLogChangeListener());

    await act(async () => {
      await Promise.resolve();
    });

    // Listener should be registered
    expect(eventListeners["sessionLogCreated"]).toHaveLength(1);
    expect(eventListeners["sessionLogUpdated"]).toHaveLength(1);

    unmount();

    // Allow the unlisten promise to resolve
    await act(async () => {
      await Promise.resolve();
    });

    expect(eventListeners["sessionLogCreated"]).toHaveLength(0);
    expect(eventListeners["sessionLogUpdated"]).toHaveLength(0);
  });
});
