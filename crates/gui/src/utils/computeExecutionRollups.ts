import type { SessionLog, StepExecution } from "../bindings";
import { parseSessionLogs } from "../types/conversation";

/** Aggregate metrics computed across an execution set. */
export interface ExecutionRollups {
  /**
   * Number of distinct TaskRuns the executions belong to (counted by
   * `task_run_id`). Executions with no `task_run_id` collapse into a single
   * pseudo-run so legacy rows register without inflating the count.
   *
   * This is the canonical run count surfaced in trace summaries — it answers
   * "how many durable runs has this task had?", not "how many step attempts
   * have we recorded?"
   */
  totalRuns: number;
  /**
   * Number of StepExecution rows in the set. Each row is a single step
   * attempt — a TaskRun typically owns several. Use this when you want to
   * communicate retry/attempt density rather than run history.
   */
  totalAttempts: number;
  /** Sum of `cost` (USD), missing values treated as 0. */
  totalCost: number;
  /**
   * Grand total of tokens processed across the set:
   * `rawInputTokens + cacheReadTokens + outputTokens`. Unlike the old
   * input+output sum, this includes cache-read ("cache hit") tokens, which
   * typically dominate and were previously invisible.
   */
  totalTokens: number;
  /** Σ `input_tokens` — raw (non-cached) prompt tokens. */
  rawInputTokens: number;
  /**
   * Cache-read ("cache hit") input tokens. Sacrum reports this as a
   * session-cumulative figure, so we take each run's *latest* execution value
   * and sum those across runs rather than summing every attempt (which would
   * multiply-count the shared session total).
   */
  cacheReadTokens: number;
  /** Σ `output_tokens` — generated output tokens. */
  outputTokens: number;
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
 * Sortable timestamp for "which attempt is latest within a run" — prefers
 * `completed_at`, falls back to `started_at`, then 0 so unparseable rows sort
 * to the start and yield to any timestamped sibling.
 */
function execOrder(execution: StepExecution): number {
  const t = execution.completed_at ?? execution.started_at;
  const ms = t ? Date.parse(t) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Cache-read tokens for the set, taking each run's latest execution value and
 * summing across runs. Sacrum's `cache_read_tokens` is session-cumulative, so
 * the newest attempt in a run already reflects that run's full cache reads;
 * summing every attempt would multiply-count it.
 */
function cacheReadByLatestPerRun(executions: readonly StepExecution[]): number {
  const latest = new Map<string | null, StepExecution>();
  for (const exec of executions) {
    const key = exec.task_run_id ?? null;
    const cur = latest.get(key);
    if (!cur || execOrder(exec) >= execOrder(cur)) latest.set(key, exec);
  }
  let sum = 0;
  for (const exec of latest.values()) {
    if (typeof exec.cache_read_tokens === "number")
      sum += exec.cache_read_tokens;
  }
  return sum;
}

export interface SessionLogCostDerivationStats {
  fullTranscriptParses: number;
  incrementalRecordParses: number;
  recordsParsed: number;
}

const sessionLogCostCache = new WeakMap<readonly SessionLog[], number>();
let sessionLogCostStats: SessionLogCostDerivationStats = {
  fullTranscriptParses: 0,
  incrementalRecordParses: 0,
  recordsParsed: 0,
};

/** Reset cost-derivation counters used by performance diagnostics and tests. */
export function resetSessionLogCostDerivationStats(): void {
  sessionLogCostStats = {
    fullTranscriptParses: 0,
    incrementalRecordParses: 0,
    recordsParsed: 0,
  };
}

export function getSessionLogCostDerivationStats(): SessionLogCostDerivationStats {
  return { ...sessionLogCostStats };
}

function sumSessionEndCosts(logs: readonly SessionLog[]): number {
  let sum = 0;
  for (const event of parseSessionLogs([...logs])) {
    if (event.kind === "session_end" && typeof event.costUsd === "number") {
      sum += event.costUsd;
    }
  }
  return sum;
}

/** Parse one changed record for incremental live cost reconciliation. */
export function costFromSessionLog(log: SessionLog): number {
  sessionLogCostStats.incrementalRecordParses += 1;
  sessionLogCostStats.recordsParsed += 1;
  return sumSessionEndCosts([log]);
}

/**
 * Sum `costUsd` across all normalized harness `session_end` events in the
 * given session logs. Returns 0 when no parseable session_end entries exist.
 */
export function costFromSessionLogs(logs: SessionLog[] | undefined): number {
  if (!logs || logs.length === 0) return 0;
  const cached = sessionLogCostCache.get(logs);
  if (cached !== undefined) return cached;
  sessionLogCostStats.fullTranscriptParses += 1;
  sessionLogCostStats.recordsParsed += logs.length;
  const sum = sumSessionEndCosts(logs);
  sessionLogCostCache.set(logs, sum);
  return sum;
}

/**
 * Compute rollup metrics across an execution set.
 *
 * Cost source preference:
 *   1. `StepExecution.cost` when present (canonical).
 *   2. Otherwise, when `logsByExecutionId` is provided, fall back to summing
 *      `cost_usd` from normalized harness `session_end` log entries for that
 *      execution.
 *   3. When `fallbackCostByExecutionId` is provided, use its incrementally
 *      maintained value before parsing the log array.
 */
export function computeExecutionRollups(
  executions: readonly StepExecution[],
  logsByExecutionId?: Readonly<Record<string, SessionLog[]>>,
  fallbackCostByExecutionId?: Readonly<Record<string, number>>
): ExecutionRollups {
  let totalCost = 0;
  let rawInputTokens = 0;
  let outputTokens = 0;
  let totalWallTimeMs = 0;
  // Executions with no `task_run_id` (legacy rows predating TaskRun lineage)
  // all share the `null` key, so they collapse into one pseudo-run rather
  // than inflating the count once per attempt.
  const distinctRunIds = new Set<string | null>();
  for (const exec of executions) {
    const execCost = parseCost(exec.cost);
    if (execCost !== null) {
      totalCost += execCost;
    } else if (
      fallbackCostByExecutionId &&
      exec.id &&
      fallbackCostByExecutionId[exec.id] !== undefined
    ) {
      totalCost += fallbackCostByExecutionId[exec.id];
    } else if (logsByExecutionId && exec.id) {
      totalCost += costFromSessionLogs(logsByExecutionId[exec.id]);
    }
    if (typeof exec.input_tokens === "number")
      rawInputTokens += exec.input_tokens;
    if (typeof exec.output_tokens === "number")
      outputTokens += exec.output_tokens;
    totalWallTimeMs += durationMs(exec);
    distinctRunIds.add(exec.task_run_id ?? null);
  }
  const cacheReadTokens = cacheReadByLatestPerRun(executions);
  return {
    totalRuns: distinctRunIds.size,
    totalAttempts: executions.length,
    totalCost,
    totalTokens: rawInputTokens + cacheReadTokens + outputTokens,
    rawInputTokens,
    cacheReadTokens,
    outputTokens,
    totalWallTimeMs,
  };
}
