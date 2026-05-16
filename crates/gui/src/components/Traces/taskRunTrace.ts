// Shared TaskRun-lineage projection consumed by THREAD, TIMELINE, and CORRIDOR.
// Lanes/groups are keyed by task_run_id; delegation edges come from
// parent_task_run_id + triggered_by_step_execution_id. Executions without a
// known task_run_id are surfaced via `orphanExecutions` for the legacy path.
// TaskRun.status (not StepExecution.status) defines the terminal state of a run.
import type { StepExecution, Task, TaskRun } from "../../bindings";
import { safeMs } from "./timeUtils";
import { summarizeExecutions, traceDebug } from "./traceDebug";

export interface TaskRunNode {
  run: TaskRun;
  /** Null when the run's task is not in the supplied tasks list. */
  task: Task | null;
  /** 0 = root run (no parent_task_run_id resolvable in the projection). */
  depth: number;
  /** Executions sorted by started_at asc with id tiebreak for stability. */
  executions: StepExecution[];
  childRunIds: string[];
}

export interface RunDelegationEdge {
  parentRunId: string;
  childRunId: string;
  /**
   * The parent execution that triggered the child run, when the run's
   * triggered_by_step_execution_id resolves to one of the parent's executions.
   * Null otherwise — render the edge from the parent's last execution before
   * the child started instead (see resolveParentExecution).
   */
  triggeringExecutionId: string | null;
}

export interface TaskRunTraceProjection {
  /** Roots first, each followed by its children recursively. */
  orderedRuns: TaskRunNode[];
  runsById: Map<string, TaskRunNode>;
  delegationEdges: RunDelegationEdge[];
  /** Executions with no known task_run_id — for the legacy fallback path. */
  orphanExecutions: StepExecution[];
  runIdByExecutionId: Map<string, string>;
  hasRuns: boolean;
}

function compareExecutions(a: StepExecution, b: StepExecution): number {
  const am = safeMs(a.started_at) ?? 0;
  const bm = safeMs(b.started_at) ?? 0;
  if (am !== bm) return am - bm;
  return (a.id ?? "").localeCompare(b.id ?? "");
}

function compareRuns(a: TaskRun, b: TaskRun): number {
  const am = safeMs(a.started_at) ?? safeMs(a.inserted_at) ?? 0;
  const bm = safeMs(b.started_at) ?? safeMs(b.inserted_at) ?? 0;
  if (am !== bm) return am - bm;
  return a.id.localeCompare(b.id);
}

export function projectTaskRunTrace(
  taskRuns: readonly TaskRun[],
  executions: readonly StepExecution[],
  tasks: readonly Task[]
): TaskRunTraceProjection {
  const tasksById = new Map<string, Task>();
  for (const t of tasks) tasksById.set(t.id, t);

  const runsById = new Map<string, TaskRunNode>();
  for (const run of taskRuns) {
    runsById.set(run.id, {
      run,
      task: tasksById.get(run.task_id) ?? null,
      depth: 0,
      executions: [],
      childRunIds: [],
    });
  }

  // Bucket executions by task_run_id; collect orphans; build exec->run lookup.
  const orphanExecutions: StepExecution[] = [];
  const runIdByExecutionId = new Map<string, string>();
  for (const exec of executions) {
    const trid = exec.task_run_id ?? null;
    if (trid && runsById.has(trid)) {
      runsById.get(trid)!.executions.push(exec);
      if (exec.id) runIdByExecutionId.set(exec.id, trid);
    } else {
      orphanExecutions.push(exec);
    }
  }
  for (const node of runsById.values()) {
    node.executions.sort(compareExecutions);
  }
  orphanExecutions.sort(compareExecutions);

  traceDebug("projection buckets", {
    taskRunCount: taskRuns.length,
    executionCount: executions.length,
    buckets: Array.from(runsById.values()).map((node) => ({
      taskRunId: node.run.id,
      executions: summarizeExecutions(node.executions),
    })),
    orphanExecutions: summarizeExecutions(orphanExecutions),
  });

  // Build parent->children adjacency. Children of a parent are sorted by
  // started_at so DFS order is chronological within a fan-out.
  const childrenByParent = new Map<string | null, TaskRun[]>();
  for (const node of runsById.values()) {
    const pid =
      node.run.parent_task_run_id && runsById.has(node.run.parent_task_run_id)
        ? node.run.parent_task_run_id
        : null;
    const list = childrenByParent.get(pid) ?? [];
    list.push(node.run);
    childrenByParent.set(pid, list);
  }
  for (const list of childrenByParent.values()) list.sort(compareRuns);

  // DFS from each root run. Roots are runs whose parent_task_run_id is null
  // OR points outside the projection.
  const orderedRuns: TaskRunNode[] = [];
  const visited = new Set<string>();
  const roots = childrenByParent.get(null) ?? [];

  function visit(run: TaskRun, depth: number): void {
    if (visited.has(run.id)) return;
    visited.add(run.id);
    const node = runsById.get(run.id)!;
    node.depth = depth;
    const kids = childrenByParent.get(run.id) ?? [];
    node.childRunIds = kids.map((k) => k.id);
    orderedRuns.push(node);
    for (const kid of kids) visit(kid, depth + 1);
  }

  for (const root of roots) visit(root, 0);

  // Catch any cycles or unreachable nodes (defensive — shouldn't happen with
  // server-issued TaskRuns) so they still appear.
  for (const node of runsById.values()) {
    if (!visited.has(node.run.id)) {
      visited.add(node.run.id);
      orderedRuns.push(node);
    }
  }

  // Delegation edges: one per child run that has a parent in the projection.
  // The triggering exec must belong to the parent run (not just exist).
  const delegationEdges: RunDelegationEdge[] = [];
  for (const node of orderedRuns) {
    const pid = node.run.parent_task_run_id;
    if (!pid || !runsById.has(pid)) continue;
    const triggerId = node.run.triggered_by_step_execution_id;
    delegationEdges.push({
      parentRunId: pid,
      childRunId: node.run.id,
      triggeringExecutionId:
        triggerId && runIdByExecutionId.get(triggerId) === pid
          ? triggerId
          : null,
    });
  }

  return {
    orderedRuns,
    runsById,
    delegationEdges,
    orphanExecutions,
    runIdByExecutionId,
    hasRuns: orderedRuns.length > 0,
  };
}

/**
 * Resolve the parent execution for a child run's delegation edge.
 *
 * Preference order:
 *   1. `task_run.triggered_by_step_execution_id` if it appears in the
 *      parent run's executions.
 *   2. The parent run's most recent execution that started at or before the
 *      child run's first execution (or, failing that, the parent's last
 *      known execution).
 *
 * Returns null when the parent has no executions in the projection.
 */
export function resolveParentExecution(
  projection: TaskRunTraceProjection,
  edge: RunDelegationEdge
): StepExecution | null {
  const parent = projection.runsById.get(edge.parentRunId);
  if (!parent || parent.executions.length === 0) return null;

  if (edge.triggeringExecutionId) {
    const found = parent.executions.find(
      (e) => e.id === edge.triggeringExecutionId
    );
    if (found) return found;
  }

  const child = projection.runsById.get(edge.childRunId);
  const childFirst = child?.executions[0];
  const childMs = childFirst ? safeMs(childFirst.started_at) : null;

  let pick: StepExecution | null = null;
  let pickMs = -Infinity;
  for (const e of parent.executions) {
    const ms = safeMs(e.started_at);
    if (ms === null) continue;
    if (childMs !== null && ms > childMs) continue;
    if (ms > pickMs) {
      pickMs = ms;
      pick = e;
    }
  }
  return pick ?? parent.executions[parent.executions.length - 1] ?? null;
}
