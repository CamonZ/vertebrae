import { describe, expect, it } from "vitest";
import { computeExecutionRollups } from "./computeExecutionRollups";
import type { SessionLog, StepExecution } from "../bindings";

function sessionEndLog(execId: string, costUsd: number, idx = 0): SessionLog {
  return {
    id: `log-${execId}-${idx}`,
    step_execution_id: execId,
    content: JSON.stringify({
      type: "result",
      subtype: "success",
      duration_ms: 1234,
      num_turns: 3,
      total_cost_usd: costUsd,
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
      totalCost: 0,
      totalTokens: 0,
      totalWallTimeMs: 0,
    });
  });

  it("sums cost, tokens (input + output), and duration_ms across executions", () => {
    const rollups = computeExecutionRollups([
      exec({ cost: "0.25", input_tokens: 100, output_tokens: 50, duration_ms: 1200 }),
      exec({ cost: "0.5", input_tokens: 200, output_tokens: 75, duration_ms: 800 }),
      exec({ cost: "0.1", input_tokens: 10, output_tokens: 5, duration_ms: 100 }),
    ]);
    expect(rollups.totalRuns).toBe(3);
    expect(rollups.totalCost).toBeCloseTo(0.85, 10);
    expect(rollups.totalTokens).toBe(100 + 50 + 200 + 75 + 10 + 5);
    expect(rollups.totalWallTimeMs).toBe(2100);
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
      exec({ cost: null, input_tokens: null, output_tokens: null, duration_ms: null }),
      exec({ cost: "0.4", input_tokens: 10, output_tokens: 20, duration_ms: 500 }),
    ]);
    expect(rollups.totalRuns).toBe(2);
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
    expect(rollups.totalRuns).toBe(2);
    expect(rollups.totalCost).toBeCloseTo(0.0742 + 0.1166, 10);
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
    expect(
      computeExecutionRollups([e], logsByExecutionId).totalCost
    ).toBe(0);
  });
});
