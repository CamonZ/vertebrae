import type { StepExecution } from "../bindings";

/** Aggregate metrics computed across an execution set. */
export interface ExecutionRollups {
  /** Number of executions in the set. */
  totalRuns: number;
  /** Sum of `cost` (USD), missing values treated as 0. */
  totalCost: number;
  /** Sum of `input_tokens + output_tokens`, missing values treated as 0. */
  totalTokens: number;
  /**
   * Sum of wall-clock durations in milliseconds.
   *
   * Prefers `duration_ms` when present, otherwise falls back to
   * `completed_at - started_at`. In-flight executions (no
   * `completed_at` and no `duration_ms`) contribute 0 — callers that
   * want elapsed-so-far must compute against a clock themselves.
   */
  totalWallTimeMs: number;
}

function durationMs(execution: StepExecution): number {
  if (typeof execution.duration_ms === "number") return execution.duration_ms;
  if (execution.started_at && execution.completed_at) {
    const start = Date.parse(execution.started_at);
    const end = Date.parse(execution.completed_at);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      return end - start;
    }
  }
  return 0;
}

export function computeExecutionRollups(
  executions: readonly StepExecution[]
): ExecutionRollups {
  let totalCost = 0;
  let totalTokens = 0;
  let totalWallTimeMs = 0;
  for (const exec of executions) {
    if (typeof exec.cost === "number") totalCost += exec.cost;
    if (typeof exec.input_tokens === "number") totalTokens += exec.input_tokens;
    if (typeof exec.output_tokens === "number")
      totalTokens += exec.output_tokens;
    totalWallTimeMs += durationMs(exec);
  }
  return {
    totalRuns: executions.length,
    totalCost,
    totalTokens,
    totalWallTimeMs,
  };
}
