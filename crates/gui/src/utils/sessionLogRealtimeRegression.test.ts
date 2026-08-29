import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionLog, StepExecution } from "../bindings";
import { useSessionLogStore } from "../stores/sessionLogStore";
import {
  computeExecutionRollups,
  getSessionLogCostDerivationStats,
  resetSessionLogCostDerivationStats,
} from "./computeExecutionRollups";
import {
  createSessionLogEventQueue,
  type QueuedSessionLogEvent,
} from "./sessionLogEventQueue";
import {
  createSessionLogPerformanceMonitor,
  makeSessionLogPerformanceCorrelation,
  SESSION_LOG_FLUSH_POLICY,
} from "./sessionLogPerformance";

const PROJECT_SCOPE = "child-6-regression";
const EXECUTION_IDS = ["exec-a", "exec-b", "exec-c"] as const;
const EMPTY_LOGS: SessionLog[] = [];

function liveLogs() {
  return Object.fromEntries(
    Object.entries(useSessionLogStore.getState().logsByExecutionId).map(
      ([executionId, bucket]) => [executionId, bucket.logs]
    )
  );
}

function liveCosts() {
  return Object.fromEntries(
    Object.entries(useSessionLogStore.getState().logsByExecutionId).map(
      ([executionId, bucket]) => [executionId, bucket.fallbackCost]
    )
  );
}

function harnessLog(
  executionId: string,
  id: string,
  type: string,
  data: Record<string, unknown> = {},
  overrides: Partial<SessionLog> = {}
): SessionLog {
  return {
    id,
    step_execution_id: executionId,
    format: "harness",
    content: JSON.stringify({
      version: 1,
      event_id: `event-${id}`,
      stream_id: `stream-${executionId}`,
      timestamp: "2026-01-01T00:00:00.000Z",
      semantics: type === "run_finished" ? "snapshot" : "delta",
      type,
      data,
    }),
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function terminalLog(
  executionId: string,
  id: string,
  logicalKey: string,
  status: "completed" | "failed",
  costUsd?: number
): SessionLog {
  return harnessLog(
    executionId,
    id,
    "run_finished",
    {
      status,
      metrics: {
        duration_ms: 1_000,
        turn_count: 2,
        ...(costUsd === undefined ? {} : { total_cost_usd: costUsd }),
      },
    },
    { logical_key: logicalKey }
  );
}

function execution(id: string): StepExecution {
  return {
    id,
    task_id: `task-${id}`,
    task_run_id: `task-run-${id}`,
    workflow_id: "workflow-1",
    step_name: "stream",
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:00:01.000Z",
    status: "completed",
    cost: null,
    input_tokens: 100,
    output_tokens: 50,
    duration_ms: 1_000,
  } as StepExecution;
}

function makeInitialEvents(executionId: string): QueuedSessionLogEvent[] {
  const events: QueuedSessionLogEvent[] = [];
  for (let index = 0; index < 24; index += 1) {
    events.push({
      executionId,
      operation: "append",
      urgent: false,
      log: harnessLog(executionId, `${executionId}-text-${index}`, "text", {
        content: `delta-${index}`,
      }),
    });
  }
  events.push({
    executionId,
    operation: "append",
    urgent: false,
    log: harnessLog(executionId, `${executionId}-tool`, "tool_call", {
      name: "Bash",
      tool_call_id: `${executionId}-tool-call`,
    }),
  });
  events.push({
    executionId,
    operation: "upsert",
    urgent: false,
    log: harnessLog(
      executionId,
      `${executionId}-thinking-v1`,
      "text",
      { content: "first snapshot" },
      { logical_key: `thinking:${executionId}` }
    ),
  });
  return events;
}

function makeReconnectEvents(
  executionId: string,
  status: "completed" | "failed",
  costUsd?: number
): QueuedSessionLogEvent[] {
  const terminalKey = `terminal:${executionId}`;
  return [
    {
      executionId,
      operation: "append",
      urgent: false,
      // Replayed after reconnect: the store must retain the original row.
      log: harnessLog(executionId, `${executionId}-text-0`, "text", {
        content: "replayed delta",
      }),
    },
    {
      executionId,
      operation: "append",
      urgent: false,
      // A recovered sequence gap is represented by a later durable row.
      log: harnessLog(executionId, `${executionId}-gap-recovered`, "text", {
        sequence: 100,
        content: "recovered delta",
      }),
    },
    {
      executionId,
      operation: "upsert",
      urgent: false,
      log: harnessLog(
        executionId,
        `${executionId}-thinking-v2`,
        "text",
        { content: "corrected snapshot" },
        { logical_key: `thinking:${executionId}` }
      ),
    },
    {
      executionId,
      operation: "upsert",
      urgent: true,
      log: terminalLog(
        executionId,
        `${executionId}-terminal-v2`,
        terminalKey,
        status,
        costUsd
      ),
    },
  ];
}

describe("session-log realtime regression", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useSessionLogStore.getState().reset();
    resetSessionLogCostDerivationStats();
  });

  afterEach(() => {
    useSessionLogStore.getState().reset();
    vi.useRealTimers();
  });

  it("keeps three concurrent high-rate runs paced, correct, scoped, and incremental", () => {
    const baseline = EXECUTION_IDS.map((executionId, index) => ({
      executionId,
      log: terminalLog(
        executionId,
        `${executionId}-terminal-v1`,
        `terminal:${executionId}`,
        "completed",
        0.1 + index * 0.01
      ),
    }));
    act(() => {
      for (const { executionId, log } of baseline) {
        useSessionLogStore.getState().setLogs(executionId, [log]);
      }
    });
    resetSessionLogCostDerivationStats();

    const monitor = createSessionLogPerformanceMonitor();
    monitor.setEnabled(true);
    const frameCallbacks: Array<() => void> = [];
    const flushSizes = new Map<string, number[]>();
    const flushCounts = new Map<string, number>();
    const rollupsByExecution = new Map<
      string,
      ReturnType<typeof computeExecutionRollups>
    >();
    const queues = new Map<
      string,
      ReturnType<typeof createSessionLogEventQueue>
    >();
    let animationFrames = 0;

    for (const executionId of EXECUTION_IDS) {
      flushSizes.set(executionId, []);
      flushCounts.set(executionId, 0);
      queues.set(
        executionId,
        createSessionLogEventQueue({
          maxBatchSize: 16,
          requestAnimationFrame: (callback) => {
            frameCallbacks.push(callback);
            return frameCallbacks.length;
          },
          cancelAnimationFrame: vi.fn(),
          onQueued: (event, pendingCount) => {
            monitor.recordQueued(
              { projectScope: PROJECT_SCOPE, executionId },
              pendingCount
            );
            if (event.executionId !== executionId) {
              throw new Error(
                "queue accepted an event for the wrong execution"
              );
            }
          },
          onOverflow: () => {
            monitor.recordOverflowReconciliation({
              projectScope: PROJECT_SCOPE,
              executionId,
            });
          },
          onFlush: (events) => {
            const sizes = flushSizes.get(executionId)!;
            sizes.push(events.length);
            flushCounts.set(executionId, flushCounts.get(executionId)! + 1);

            useSessionLogStore.getState().applyLogBatch(
              events.map(({ executionId: id, log, operation }) => ({
                executionId: id,
                log,
                operation,
              }))
            );
            monitor.recordFlush(
              { projectScope: PROJECT_SCOPE, executionId },
              events.length,
              1
            );
            for (const event of events) {
              if (event.correlation)
                monitor.recordVisible(event.correlation, 8);
            }

            const state = useSessionLogStore.getState();
            const currentExecution = execution(executionId);
            rollupsByExecution.set(
              executionId,
              computeExecutionRollups(
                [currentExecution],
                liveLogs(),
                liveCosts()
              )
            );
            monitor.recordRollup(
              { projectScope: PROJECT_SCOPE, executionId },
              events.length,
              1
            );
            monitor.recordRetainedRecords(
              { projectScope: PROJECT_SCOPE, executionId },
              state.logsByExecutionId[executionId]?.logs.length ?? 0
            );
          },
        })
      );
    }

    let activeConsumerRenders = 0;
    const { result: activeConsumer, unmount } = renderHook(() => {
      activeConsumerRenders += 1;
      return useSessionLogStore(
        (state) => state.logsByExecutionId[EXECUTION_IDS[0]]?.logs ?? EMPTY_LOGS
      );
    });
    const settledActiveConsumerRenders = activeConsumerRenders;

    const enqueue = (event: QueuedSessionLogEvent) => {
      const correlation = makeSessionLogPerformanceCorrelation({
        projectScope: PROJECT_SCOPE,
        executionId: event.executionId,
        logId: event.log.id,
        logicalKey: event.log.logical_key,
      });
      monitor.recordReceived(correlation, 0);
      queues.get(event.executionId)!.enqueue({ ...event, correlation });
    };

    const drainAnimationFrames = () => {
      while (frameCallbacks.length > 0) {
        const callbacks = frameCallbacks.splice(0);
        animationFrames += 1;
        for (const callback of callbacks) callback();
      }
    };

    act(() => {
      const initialEvents = new Map(
        EXECUTION_IDS.map((executionId) => [
          executionId,
          makeInitialEvents(executionId),
        ])
      );
      for (let index = 0; index < 26; index += 1) {
        for (const executionId of EXECUTION_IDS) {
          enqueue(initialEvents.get(executionId)![index]);
        }
      }
      drainAnimationFrames();

      for (const [index, executionId] of EXECUTION_IDS.entries()) {
        for (const event of makeReconnectEvents(
          executionId,
          index === 1 ? "failed" : "completed",
          index === 1 ? undefined : 0.2 + index * 0.1
        )) {
          enqueue(event);
        }
      }
      drainAnimationFrames();
    });

    expect(animationFrames).toBe(3);
    expect([...flushCounts.values()]).toEqual([3, 3, 3]);
    for (const executionId of EXECUTION_IDS) {
      const sizes = flushSizes.get(executionId)!;
      expect(sizes).toEqual([16, 10, 4]);
      expect(
        sizes.every((size) => size <= SESSION_LOG_FLUSH_POLICY.maxBatchSize)
      ).toBe(true);
      expect(queues.get(executionId)!.pendingCount).toBe(0);
    }

    const state = useSessionLogStore.getState();
    for (const executionId of EXECUTION_IDS) {
      const logs = state.logsByExecutionId[executionId]?.logs ?? EMPTY_LOGS;
      expect(logs).toHaveLength(28);
      expect(logs[0].id).toBe(`${executionId}-terminal-v2`);
      expect(
        logs.find((log) => log.logical_key === `thinking:${executionId}`)
          ?.content
      ).toContain("corrected snapshot");
      expect(
        logs.filter((log) => log.id === `${executionId}-text-0`)
      ).toHaveLength(1);
      expect(
        logs.some((log) => log.id === `${executionId}-gap-recovered`)
      ).toBe(true);
    }
    expect(liveCosts()).toEqual({
      "exec-a": 0.2,
      "exec-b": 0,
      "exec-c": 0.4,
    });

    const allExecutions = EXECUTION_IDS.map(execution);
    const finalRollups = computeExecutionRollups(
      allExecutions,
      liveLogs(),
      liveCosts()
    );
    expect(finalRollups.totalCost).toBeCloseTo(0.6, 10);
    expect(finalRollups).toMatchObject({
      totalRuns: 3,
      totalAttempts: 3,
      totalTokens: 450,
      rawInputTokens: 300,
      outputTokens: 150,
      totalWallTimeMs: 3_000,
    });

    const derivationStats = getSessionLogCostDerivationStats();
    expect(derivationStats).toEqual({
      fullTranscriptParses: 0,
      incrementalRecordParses: 6,
      recordsParsed: 6,
    });
    expect(rollupsByExecution.get("exec-a")?.totalCost).toBeCloseTo(0.2, 10);
    expect(rollupsByExecution.get("exec-b")?.totalCost).toBeCloseTo(0, 10);
    expect(rollupsByExecution.get("exec-c")?.totalCost).toBeCloseTo(0.4, 10);

    const snapshot = monitor.snapshot();
    expect(snapshot.project).toMatchObject({
      eventsReceived: 90,
      eventsFlushed: 90,
      storeCommits: 9,
      rollupRuns: 9,
      rollupRecordsProcessed: 90,
      maxBatchSize: 16,
      maxQueueDepth: 26,
      retainedRecords: 28,
      overflowReconciliations: 0,
    });
    expect(snapshot.project.eventToVisibleLatencyMs.p95).toBeLessThanOrEqual(
      SESSION_LOG_FLUSH_POLICY.eventToVisibleLatencyBudgetMs
    );
    for (const executionId of EXECUTION_IDS) {
      expect(snapshot.executions[executionId]).toMatchObject({
        eventsReceived: 30,
        eventsFlushed: 30,
        storeCommits: 3,
        rollupRuns: 3,
        rollupRecordsProcessed: 30,
        maxBatchSize: 16,
        maxQueueDepth: 26,
        retainedRecords: 28,
      });
    }

    // Traffic for the other two runs does not invalidate the active selector.
    expect(activeConsumerRenders).toBeGreaterThan(settledActiveConsumerRenders);
    const rendersAfterActiveTraffic = activeConsumerRenders;
    act(() => {
      useSessionLogStore.getState().applyLogBatch([
        {
          executionId: EXECUTION_IDS[1],
          operation: "append",
          log: harnessLog("exec-b", "exec-b-late", "text"),
        },
        {
          executionId: EXECUTION_IDS[2],
          operation: "append",
          log: harnessLog("exec-c", "exec-c-late", "text"),
        },
      ]);
    });
    expect(activeConsumerRenders).toBe(rendersAfterActiveTraffic);
    expect(activeConsumer.current).toHaveLength(28);

    for (const queue of queues.values()) queue.dispose({ flush: false });
    unmount();
  });

  it("keeps the default closed diagnostic path allocation-free while opt-in metrics remain bounded", () => {
    const monitor = createSessionLogPerformanceMonitor();
    const correlation = makeSessionLogPerformanceCorrelation({
      projectScope: PROJECT_SCOPE,
      executionId: EXECUTION_IDS[0],
      logId: "diagnostic-log",
    });

    monitor.recordReceived(correlation, 0);
    monitor.recordQueued(
      { projectScope: PROJECT_SCOPE, executionId: EXECUTION_IDS[0] },
      1
    );
    expect(monitor.enabled).toBe(false);
    expect(monitor.snapshot().project.eventsReceived).toBe(0);

    monitor.setEnabled(true);
    monitor.recordReceived(correlation, 0);
    monitor.recordQueued(
      { projectScope: PROJECT_SCOPE, executionId: EXECUTION_IDS[0] },
      1
    );
    monitor.recordFlush(
      { projectScope: PROJECT_SCOPE, executionId: EXECUTION_IDS[0] },
      1,
      2
    );
    monitor.recordVisible(correlation, 8);

    expect(monitor.snapshot()).toMatchObject({
      enabled: true,
      project: {
        eventsReceived: 1,
        eventsQueued: 1,
        eventsFlushed: 1,
        eventsVisible: 1,
        storeCommits: 1,
      },
    });
    expect(
      monitor.snapshot().project.eventToVisibleLatencyMs.p95
    ).toBeLessThanOrEqual(
      SESSION_LOG_FLUSH_POLICY.eventToVisibleLatencyBudgetMs
    );
  });
});
