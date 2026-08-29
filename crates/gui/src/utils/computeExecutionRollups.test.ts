import { describe, expect, it } from "vitest";
import {
  computeExecutionRollups,
  costFromSessionLogs,
  getSessionLogCostDerivationStats,
  resetSessionLogCostDerivationStats,
} from "./computeExecutionRollups";
import type { SessionLog, StepExecution } from "../bindings";

function sessionEndLog(execId: string, costUsd: number, idx = 0): SessionLog {
  const eventId = `event-${execId}-${idx}`;
  return {
    id: `log-${execId}-${idx}`,
    step_execution_id: execId,
    format: "harness",
    content: JSON.stringify({
      version: 1,
      event_id: eventId,
      stream_id: "stream-1",
      correlation: { session_id: "session-1", thread_id: "thread-1" },
      timestamp: "2026-01-01T00:00:00.000Z",
      semantics: "snapshot",
      type: "run_finished",
      data: {
        status: "completed",
        metrics: {
          duration_ms: 1234,
          turn_count: 3,
          total_cost_usd: costUsd,
        },
      },
    }),
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function exec(overrides: Partial<StepExecution> = {}): StepExecution {
  return {
    id: `exec-${Math.random().toString(36).slice(2, 8)}`,
    task_id: "t",
    workflow_id: "wf",
    step_name: "step",
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
    status: "completed",
    ...overrides,
  };
}

describe("computeExecutionRollups", () => {
  it("returns zeros for an empty list", () => {
    expect(computeExecutionRollups([])).toEqual({
      totalRuns: 0,
      totalAttempts: 0,
      totalCost: 0,
      totalTokens: 0,
      rawInputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      totalWallTimeMs: 0,
    });
  });

  it("sums cost, tokens (input + output), and duration_ms across executions", () => {
    const rollups = computeExecutionRollups([
      exec({
        cost: "0.25",
        input_tokens: 100,
        output_tokens: 50,
        duration_ms: 1200,
      }),
      exec({
        cost: "0.5",
        input_tokens: 200,
        output_tokens: 75,
        duration_ms: 800,
      }),
      exec({
        cost: "0.1",
        input_tokens: 10,
        output_tokens: 5,
        duration_ms: 100,
      }),
    ]);
    // Unattributed executions collapse into a single pseudo-run so the count
    // reflects "runs we know about", not raw attempt density.
    expect(rollups.totalRuns).toBe(1);
    expect(rollups.totalAttempts).toBe(3);
    expect(rollups.totalCost).toBeCloseTo(0.85, 10);
    expect(rollups.rawInputTokens).toBe(100 + 200 + 10);
    expect(rollups.outputTokens).toBe(50 + 75 + 5);
    expect(rollups.cacheReadTokens).toBe(0);
    // With no cache reads, the grand total still equals raw input + output.
    expect(rollups.totalTokens).toBe(100 + 50 + 200 + 75 + 10 + 5);
    expect(rollups.totalWallTimeMs).toBe(2100);
  });

  it("breaks tokens into raw input / cache hits / output and folds cache into the total", () => {
    const rollups = computeExecutionRollups([
      exec({
        task_run_id: "run-A",
        input_tokens: 100,
        output_tokens: 40,
        cache_read_tokens: 5000,
      }),
    ]);
    expect(rollups.rawInputTokens).toBe(100);
    expect(rollups.outputTokens).toBe(40);
    expect(rollups.cacheReadTokens).toBe(5000);
    expect(rollups.totalTokens).toBe(100 + 5000 + 40);
  });

  it("takes each run's latest cache_read (session-cumulative), not the sum of attempts", () => {
    // cache_read_tokens is cumulative across the provider session, so the
    // newest attempt already reflects the run's full cache reads. Summing all
    // three attempts (3000+6000+9000) would triple-count.
    const rollups = computeExecutionRollups([
      exec({
        task_run_id: "run-X",
        completed_at: "2026-01-01T00:00:01.000Z",
        cache_read_tokens: 3000,
      }),
      exec({
        task_run_id: "run-X",
        completed_at: "2026-01-01T00:00:03.000Z",
        cache_read_tokens: 9000,
      }),
      exec({
        task_run_id: "run-X",
        completed_at: "2026-01-01T00:00:02.000Z",
        cache_read_tokens: 6000,
      }),
    ]);
    expect(rollups.cacheReadTokens).toBe(9000);
  });

  it("sums latest cache_read across distinct runs", () => {
    const rollups = computeExecutionRollups([
      exec({ task_run_id: "run-A", cache_read_tokens: 1000 }),
      exec({ task_run_id: "run-B", cache_read_tokens: 2000 }),
    ]);
    expect(rollups.cacheReadTokens).toBe(3000);
  });

  it("counts distinct task_run_ids as totalRuns and StepExecutions as totalAttempts", () => {
    const rollups = computeExecutionRollups([
      exec({ id: "e-1", task_run_id: "run-A", cost: "0.1" }),
      exec({ id: "e-2", task_run_id: "run-A", cost: "0.2" }),
      exec({ id: "e-3", task_run_id: "run-B", cost: "0.3" }),
      exec({ id: "e-4", task_run_id: "run-C", cost: "0.4" }),
    ]);
    expect(rollups.totalRuns).toBe(3);
    expect(rollups.totalAttempts).toBe(4);
    expect(rollups.totalCost).toBeCloseTo(1.0, 10);
  });

  it("does not double-count failed retries inside the same TaskRun", () => {
    // The exact scenario the ticket calls out: a TaskRun that retried a
    // step several times after failures must still count as one run.
    const rollups = computeExecutionRollups([
      exec({ id: "attempt-1", task_run_id: "run-X", status: "failed" }),
      exec({ id: "attempt-2", task_run_id: "run-X", status: "failed" }),
      exec({ id: "attempt-3", task_run_id: "run-X", status: "completed" }),
    ]);
    expect(rollups.totalRuns).toBe(1);
    expect(rollups.totalAttempts).toBe(3);
  });

  it("collapses every execution missing task_run_id into a single unknown run", () => {
    // Legacy rows emitted before TaskRun lineage existed have null
    // task_run_id. They should appear as a single "unknown" run rather than
    // inflating the count once per attempt.
    const rollups = computeExecutionRollups([
      exec({ id: "legacy-1", task_run_id: null }),
      exec({ id: "legacy-2", task_run_id: null }),
      exec({ id: "legacy-3", task_run_id: undefined }),
    ]);
    expect(rollups.totalRuns).toBe(1);
    expect(rollups.totalAttempts).toBe(3);
  });

  it("counts a mix of known and unknown task_run_ids correctly", () => {
    const rollups = computeExecutionRollups([
      exec({ id: "e-1", task_run_id: "run-A" }),
      exec({ id: "e-2", task_run_id: null }),
      exec({ id: "e-3", task_run_id: null }),
      exec({ id: "e-4", task_run_id: "run-B" }),
    ]);
    // run-A, run-B, plus the unknown bucket = 3 runs across 4 attempts.
    expect(rollups.totalRuns).toBe(3);
    expect(rollups.totalAttempts).toBe(4);
  });

  it("falls back to completed_at - started_at when duration_ms is missing", () => {
    const rollups = computeExecutionRollups([
      exec({
        started_at: "2026-01-01T00:00:00.000Z",
        completed_at: "2026-01-01T00:00:05.000Z",
        duration_ms: null,
      }),
    ]);
    expect(rollups.totalWallTimeMs).toBe(5000);
  });

  it("treats missing fields as zero contribution", () => {
    const rollups = computeExecutionRollups([
      exec({
        cost: null,
        input_tokens: null,
        output_tokens: null,
        duration_ms: null,
      }),
      exec({
        cost: "0.4",
        input_tokens: 10,
        output_tokens: 20,
        duration_ms: 500,
      }),
    ]);
    // Both executions lack task_run_id, so they collapse into one pseudo-run.
    expect(rollups.totalRuns).toBe(1);
    expect(rollups.totalAttempts).toBe(2);
    expect(rollups.totalCost).toBeCloseTo(0.4, 10);
    expect(rollups.totalTokens).toBe(30);
    expect(rollups.totalWallTimeMs).toBe(500);
  });

  it("falls back to session_end log cost_usd when StepExecution.cost is null", () => {
    // Reproduces the bug from ticket ae4283f5: backend never persisted
    // StepExecution.cost on completed runs, but the session-end log entries
    // carry the real cost. The rollup must walk the logs to recover Σ COST.
    const e1 = exec({ id: "exec-1", cost: null });
    const e2 = exec({ id: "exec-2", cost: null });
    const logsByExecutionId = {
      "exec-1": [sessionEndLog("exec-1", 0.0742)],
      "exec-2": [sessionEndLog("exec-2", 0.1166)],
    };
    const rollups = computeExecutionRollups([e1, e2], logsByExecutionId);
    // Both legacy executions have no task_run_id → one unknown pseudo-run.
    expect(rollups.totalRuns).toBe(1);
    expect(rollups.totalAttempts).toBe(2);
    expect(rollups.totalCost).toBeCloseTo(0.0742 + 0.1166, 10);
  });

  it("memoizes fallback cost for an unchanged transcript array", () => {
    const logs = [sessionEndLog("exec-1", 0.0742)];
    resetSessionLogCostDerivationStats();

    expect(costFromSessionLogs(logs)).toBeCloseTo(0.0742, 10);
    expect(costFromSessionLogs(logs)).toBeCloseTo(0.0742, 10);

    expect(getSessionLogCostDerivationStats()).toEqual({
      fullTranscriptParses: 1,
      incrementalRecordParses: 0,
      recordsParsed: 1,
    });
  });

  it("sums multiple session_end events within a single execution", () => {
    // A resumed execution can emit more than one `result` line; we want all
    // of them counted, not just the first or last.
    const e = exec({ id: "exec-1", cost: null });
    const logsByExecutionId = {
      "exec-1": [
        sessionEndLog("exec-1", 0.05, 0),
        sessionEndLog("exec-1", 0.07, 1),
      ],
    };
    expect(
      computeExecutionRollups([e], logsByExecutionId).totalCost
    ).toBeCloseTo(0.12, 10);
  });

  it("prefers StepExecution.cost over log fallback when both are present", () => {
    // The backend value is canonical; the log fallback only fires when
    // StepExecution.cost is null. This avoids double-counting on healthy rows.
    const e = exec({ id: "exec-1", cost: "0.01" });
    const logsByExecutionId = {
      "exec-1": [sessionEndLog("exec-1", 0.99)],
    };
    expect(
      computeExecutionRollups([e], logsByExecutionId).totalCost
    ).toBeCloseTo(0.01, 10);
  });

  it("ignores logs whose execution.id is missing", () => {
    const e = exec({ id: null, cost: null });
    const logsByExecutionId = {
      "exec-1": [sessionEndLog("exec-1", 0.5)],
    };
    expect(computeExecutionRollups([e], logsByExecutionId).totalCost).toBe(0);
  });
});
