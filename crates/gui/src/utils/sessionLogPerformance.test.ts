import { describe, expect, it } from "vitest";
import {
  createSessionLogPerformanceMonitor,
  makeSessionLogPerformanceCorrelation,
  SESSION_LOG_FLUSH_POLICY,
} from "./sessionLogPerformance";

describe("session-log performance contract", () => {
  it("keeps instrumentation disabled and allocation-free until explicitly enabled", () => {
    const monitor = createSessionLogPerformanceMonitor();
    const correlation = makeSessionLogPerformanceCorrelation({
      projectScope: "project-1",
      executionId: "exec-a",
      logId: "log-1",
    });

    monitor.recordReceived(correlation, 10);
    monitor.recordQueued(correlation, 1);
    monitor.recordFlush(correlation, 1, 2);

    expect(monitor.enabled).toBe(false);
    expect(monitor.snapshot().project.eventsReceived).toBe(0);
    expect(monitor.snapshot().executions).toEqual({});
  });

  it("records project and execution stages with deterministic latency percentiles", () => {
    const monitor = createSessionLogPerformanceMonitor();
    monitor.setEnabled(true);
    const first = makeSessionLogPerformanceCorrelation({
      projectScope: "generation-4",
      executionId: "exec-a",
      logId: "log-1",
    });
    const second = makeSessionLogPerformanceCorrelation({
      projectScope: "generation-4",
      executionId: "exec-a",
      logicalKey: "thinking:session-1",
    });

    monitor.recordReceived(first, 100);
    monitor.recordReceived(second, 100);
    monitor.recordQueued(
      { projectScope: "generation-4", executionId: "exec-a" },
      2
    );
    monitor.recordFlush(
      { projectScope: "generation-4", executionId: "exec-a" },
      2,
      3
    );
    monitor.recordVisible(first, 120);
    monitor.recordVisible(second, 160);
    monitor.recordRollup(
      { projectScope: "generation-4", executionId: "exec-a" },
      2,
      4
    );
    monitor.recordRender({ projectScope: "generation-4", executionId: "exec-a" });
    monitor.recordRetainedRecords(
      { projectScope: "generation-4", executionId: "exec-a" },
      2
    );

    const snapshot = monitor.snapshot();
    expect(snapshot.project).toMatchObject({
      eventsReceived: 2,
      eventsQueued: 1,
      eventsFlushed: 2,
      eventsVisible: 2,
      storeCommits: 1,
      rollupRuns: 1,
      rollupRecordsProcessed: 2,
      renderCommits: 1,
      maxBatchSize: 2,
      retainedRecords: 2,
    });
    expect(snapshot.project.eventToVisibleLatencyMs).toEqual({
      count: 2,
      p50: 20,
      p95: 60,
      max: 60,
    });
    expect(snapshot.executions["exec-a"]).toMatchObject({
      eventsReceived: 2,
      eventsFlushed: 2,
      rollupRecordsProcessed: 2,
    });
  });

  it("keeps correlation identity stable for logical updates and exposes the pacing budget", () => {
    const logical = makeSessionLogPerformanceCorrelation({
      projectScope: "p",
      executionId: "e",
      logId: "new-id",
      logicalKey: "thinking:s1",
    });
    const idOnly = makeSessionLogPerformanceCorrelation({
      projectScope: "p",
      executionId: "e",
      logId: "durable-id",
    });

    expect(logical.recordKey).toBe("logical:thinking:s1");
    expect(idOnly.recordKey).toBe("id:durable-id");
    expect(SESSION_LOG_FLUSH_POLICY.maxFlushIntervalMs).toBeGreaterThanOrEqual(
      16
    );
    expect(SESSION_LOG_FLUSH_POLICY.maxFlushIntervalMs).toBeLessThanOrEqual(
      50
    );
    expect(SESSION_LOG_FLUSH_POLICY.maxPendingRecords).toBeGreaterThan(0);
  });
});
