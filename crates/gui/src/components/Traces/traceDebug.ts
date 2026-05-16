import type { StepExecution, TaskRun } from "../../bindings";
import type { TaskRunTraceProjection } from "./taskRunTrace";

type ExecutionSummary = {
  count: number;
  items: Array<{
    id: string;
    task_run_id: string | null;
    task_id: string;
    step_name: string | null;
    status: StepExecution["status"];
  }>;
  ids: string[];
  duplicateIds: string[];
  byRun: Record<string, string[]>;
  missingRunIds: string[];
};

type RunSummary = {
  count: number;
  ids: string[];
  duplicateIds: string[];
  parentByRun: Record<string, string | null>;
};

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) dupes.add(value);
    else seen.add(value);
  }
  return [...dupes];
}

export function summarizeExecutions(
  executions: readonly StepExecution[]
): ExecutionSummary {
  const ids = executions.map((exec) => exec.id ?? "(missing-id)");
  const items = executions.map((exec) => ({
    id: exec.id ?? "(missing-id)",
    task_run_id: exec.task_run_id ?? null,
    task_id: exec.task_id ?? "(missing-task)",
    step_name: exec.step_name ?? null,
    status: exec.status,
  }));
  const byRun: Record<string, string[]> = {};
  const missingRunIds: string[] = [];

  for (const exec of executions) {
    const execId = exec.id ?? "(missing-id)";
    const runId = exec.task_run_id ?? "(missing-task-run)";
    const bucket = byRun[runId] ?? [];
    bucket.push(execId);
    byRun[runId] = bucket;
    if (!exec.task_run_id) missingRunIds.push(execId);
  }

  return {
    count: executions.length,
    items,
    ids,
    duplicateIds: duplicates(ids.filter((id) => id !== "(missing-id)")),
    byRun,
    missingRunIds,
  };
}

export function summarizeRuns(runs: readonly TaskRun[]): RunSummary {
  const ids = runs.map((run) => run.id);
  const parentByRun: Record<string, string | null> = {};
  for (const run of runs) parentByRun[run.id] = run.parent_task_run_id ?? null;
  return {
    count: runs.length,
    ids,
    duplicateIds: duplicates(ids),
    parentByRun,
  };
}

export function summarizeProjection(
  projection: TaskRunTraceProjection | null
): unknown {
  if (!projection) return null;
  return {
    orderedRuns: projection.orderedRuns.map((node) => ({
      runId: node.run.id,
      parentRunId: node.run.parent_task_run_id ?? null,
      depth: node.depth,
      executionIds: node.executions.map((exec) => exec.id ?? "(missing-id)"),
      duplicateExecutionIds: summarizeExecutions(node.executions).duplicateIds,
      childRunIds: node.childRunIds,
    })),
    orphanExecutions: summarizeExecutions(projection.orphanExecutions),
    delegationEdges: projection.delegationEdges,
  };
}

export function traceDebug(label: string, payload: unknown): void {
  console.debug(`[Traces:step-executions] ${label}`, payload);
}
