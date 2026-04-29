import { describe, expect, it } from "vitest";
import { computeExecutionRollups } from "./computeExecutionRollups";
import type { StepExecution } from "../bindings";

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
      exec({ cost: 0.25, input_tokens: 100, output_tokens: 50, duration_ms: 1200 }),
      exec({ cost: 0.5, input_tokens: 200, output_tokens: 75, duration_ms: 800 }),
      exec({ cost: 0.1, input_tokens: 10, output_tokens: 5, duration_ms: 100 }),
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
      exec({ cost: 0.4, input_tokens: 10, output_tokens: 20, duration_ms: 500 }),
    ]);
    expect(rollups.totalRuns).toBe(2);
    expect(rollups.totalCost).toBeCloseTo(0.4, 10);
    expect(rollups.totalTokens).toBe(30);
    expect(rollups.totalWallTimeMs).toBe(500);
  });
});
