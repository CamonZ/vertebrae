import { act, renderHook } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

type EventCallback = (event: { payload: Record<string, unknown> }) => void;

const { mockEvents, eventListeners, emitEvent } = vi.hoisted(() => {
  const listeners: Record<string, EventCallback[]> = {};

  function createEventListener(eventName: string) {
    return {
      listen: vi.fn((callback: EventCallback) => {
        listeners[eventName] = listeners[eventName] || [];
        listeners[eventName].push(callback);
        return Promise.resolve(() => {
          const index = listeners[eventName].indexOf(callback);
          if (index >= 0) listeners[eventName].splice(index, 1);
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
      for (const callback of listeners[eventName] || []) callback({ payload });
    },
  };
});

vi.mock("../bindings", () => ({ events: mockEvents }));

import { useSessionLogChangeListener } from "../hooks/useSessionLogChangeListener";
import { useSessionLogStore } from "../stores/sessionLogStore";
import { computeExecutionRollups } from "./computeExecutionRollups";
import type { SessionLog, StepExecution } from "../bindings";

const EXECUTION_IDS = ["exec-a", "exec-b", "exec-c"] as const;

function execution(id: string): StepExecution {
  return {
    id,
    task_id: "task-1",
    workflow_id: "workflow-1",
    task_run_id: `run-${id}`,
    step_name: "step",
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:00:01.000Z",
    status: "completed",
    cost: null,
    input_tokens: 100,
    output_tokens: 50,
    duration_ms: 1000,
  };
}

function log(id: string, executionId: string): SessionLog {
  return {
    id,
    step_execution_id: executionId,
    content: "ordinary session output",
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function terminalLog(
  id: string,
  executionId: string,
  costUsd: number
): SessionLog {
  return {
    ...log(id, executionId),
    format: "harness",
    content: JSON.stringify({
      version: 1,
      event_id: id,
      stream_id: "stream-1",
      correlation: { session_id: "session-1", thread_id: "thread-1" },
      timestamp: "2026-01-01T00:00:00.000Z",
      semantics: "snapshot",
      type: "run_finished",
      data: {
        status: "completed",
        metrics: { total_cost_usd: costUsd },
      },
    }),
  };
}

describe("session-log realtime regression", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", undefined);
    for (const key of Object.keys(eventListeners)) eventListeners[key] = [];
    useSessionLogStore.getState().reset();
  });

  afterEach(() => {
    useSessionLogStore.getState().reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function flushOneScheduledBatch() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
  }

  async function registerListener() {
    renderHook(() => useSessionLogChangeListener());
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("keeps high-rate concurrent delivery bounded while preserving every record", async () => {
    await registerListener();
    const totalRecords: number[] = [];
    const unsubscribe = useSessionLogStore.subscribe((state) => {
      totalRecords.push(
        Object.values(state.logsByExecutionId).reduce(
          (total, bucket) => total + bucket.logs.length,
          0
        )
      );
    });

    for (const executionId of EXECUTION_IDS) {
      for (let index = 0; index < 300; index += 1) {
        emitEvent("sessionLogCreated", {
          log_id: `${executionId}-${index}`,
          step_execution_id: executionId,
          session_log: log(`${executionId}-${index}`, executionId),
        });
      }
    }

    expect(totalRecords).toEqual([]);
    for (let index = 0; index < 4; index += 1) {
      await flushOneScheduledBatch();
    }
    unsubscribe();

    expect(totalRecords).toEqual([256, 512, 768, 900]);
    for (const executionId of EXECUTION_IDS) {
      expect(
        useSessionLogStore.getState().logsByExecutionId[executionId]?.logs
      ).toHaveLength(300);
    }
  });

  it("keeps terminal fallback cost in the same bucket consumed by rollups", async () => {
    await registerListener();
    emitEvent("sessionLogCreated", {
      log_id: "terminal-a",
      step_execution_id: "exec-a",
      session_log: terminalLog("terminal-a", "exec-a", 0.42),
    });
    await flushOneScheduledBatch();

    const bucket = useSessionLogStore.getState().logsByExecutionId["exec-a"];
    expect(bucket?.fallbackCost).toBeCloseTo(0.42, 10);
    expect(
      computeExecutionRollups([execution("exec-a")], {
        "exec-a": bucket!,
      }).totalCost
    ).toBeCloseTo(0.42, 10);
  });
});
