import { describe, it, expect, beforeEach, vi } from "vitest";
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
import { useSessionLogStore } from "../stores";
import { useToastStore } from "../stores";

describe("useSessionLogChangeListener", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(eventListeners).forEach((key) => {
      eventListeners[key] = [];
    });
    // Reset stores between tests
    useSessionLogStore.setState({ logsByExecutionId: {} });
    useToastStore.getState().clearToasts();
  });

  it("calls appendLog when session_log is present in the event", async () => {
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

    const logs = useSessionLogStore.getState().logsByExecutionId["exec-001"];
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual(sessionLog);
    expect(logs[0].id).toBe("log-abc123");
    expect(logs[0].content).toBe("Step started execution");
    expect(logs[0].step_execution_id).toBe("exec-001");
  });

  it("does not call appendLog when session_log is null", async () => {
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

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(0);
  });

  it("cleans up listener on unmount", async () => {
    const { unmount } = renderHook(() => useSessionLogChangeListener());

    await act(async () => {
      await Promise.resolve();
    });

    // Listener should be registered
    expect(eventListeners["sessionLogCreated"]).toHaveLength(1);

    unmount();

    // Allow the unlisten promise to resolve
    await act(async () => {
      await Promise.resolve();
    });

    expect(eventListeners["sessionLogCreated"]).toHaveLength(0);
  });
});
