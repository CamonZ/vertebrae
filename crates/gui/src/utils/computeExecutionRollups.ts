import type { SessionLog, StepExecution } from "../bindings";
import { parseSessionLogs } from "../types/conversation";

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

/**
 * Parse a `StepExecution.cost` value (string-encoded Decimal from Sacrum)
 * into a finite number, or null when missing/unparseable.
 */
export function parseCost(cost: string | null | undefined): number | null {
  if (cost == null) return null;
  const n = Number(cost);
  return Number.isFinite(n) ? n : null;
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

/**
 * Sum `costUsd` across all `session_end` events in the given session logs.
 * Returns 0 when no parseable session_end entries exist.
 */
export function costFromSessionLogs(logs: SessionLog[] | undefined): number {
  if (!logs || logs.length === 0) return 0;
  let sum = 0;
  for (const event of parseSessionLogs(logs)) {
    if (event.kind === "session_end" && typeof event.costUsd === "number") {
      sum += event.costUsd;
    }
  }
  return sum;
}

/**
 * Compute rollup metrics across an execution set.
 *
 * Cost source preference:
 *   1. `StepExecution.cost` when present (canonical, populated by the daemon
 *      from Claude's `result` event).
 *   2. Otherwise, when `logsByExecutionId` is provided, fall back to summing
 *      `cost_usd` from `session_end` log entries for that execution. This
 *      keeps the Σ COST rollup honest for runs where the backend never
 *      persisted `StepExecution.cost` (e.g. older completed runs, or runs
 *      whose result event arrived before the cost-write codepath landed).
 */
export function computeExecutionRollups(
  executions: readonly StepExecution[],
  logsByExecutionId?: Readonly<Record<string, SessionLog[]>>
): ExecutionRollups {
  let totalCost = 0;
  let totalTokens = 0;
  let totalWallTimeMs = 0;
  for (const exec of executions) {
    const execCost = parseCost(exec.cost);
    if (execCost !== null) {
      totalCost += execCost;
    } else if (logsByExecutionId && exec.id) {
      totalCost += costFromSessionLogs(logsByExecutionId[exec.id]);
    }
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
