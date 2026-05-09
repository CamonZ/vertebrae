/**
 * CORRIDOR layout — converts a subtree's executions into a DAG suitable for
 * an SVG canvas:
 *
 * - Each task gets a vertical column (lane). Columns are ordered by DFS over
 *   the parent → child relationship rooted at `rootTaskId` so descendants sit
 *   to the right of their parent.
 * - Each execution becomes a node placed at (column.x, time-ordered y).
 * - Transition edges connect consecutive executions on the same task in
 *   chronological order.
 * - Delegation edges connect the parent task execution that was active when
 *   a descendant task's first execution started, to that descendant's first
 *   execution node.
 *
 * Status semantics for nodes:
 *   - failed | rejected (step name matches /reject|revise|fail/i)  -> "failed"
 *   - in_progress                                                  -> "active"
 *   - completed                                                    -> "done"
 */
import type { StepExecution, Task } from "../../bindings";
import {
  resolveParentExecution,
  type TaskRunTraceProjection,
} from "./taskRunTrace";
import { safeMs } from "./timeUtils";

export type CorridorNodeStatus = "active" | "done" | "failed";

export interface CorridorNode {
  id: string;
  executionId: string;
  taskId: string;
  /** TaskRun this execution belongs to, when known. */
  taskRunId: string | null;
  stepName: string | null;
  status: CorridorNodeStatus;
  startedAtMs: number | null;
  /** Column index (lane), 0-based, left-to-right. */
  column: number;
  /** Row index within the column (chronological), 0-based. */
  row: number;
  /** Pixel x at node center (laid out by computeCorridorLayout). */
  x: number;
  /** Pixel y at node center. */
  y: number;
}

export interface CorridorEdge {
  id: string;
  kind: "transition" | "delegation";
  fromNodeId: string;
  toNodeId: string;
}

export interface CorridorLane {
  /** TaskRun id for run-aware layouts; Task id for the legacy layout. */
  laneId: string;
  taskId: string;
  /** Null in the legacy task-keyed layout. */
  taskRunId: string | null;
  title: string | null;
  column: number;
  /** Pixel x of the lane center. */
  x: number;
  nodeCount: number;
}

export interface CorridorLayout {
  nodes: CorridorNode[];
  edges: CorridorEdge[];
  lanes: CorridorLane[];
  /** Pixel width of the laid-out canvas. */
  width: number;
  /** Pixel height of the laid-out canvas. */
  height: number;
}

export interface CorridorLayoutOptions {
  /** Horizontal distance between lane centers. */
  columnSpacing?: number;
  /** Vertical distance between consecutive nodes within a lane. */
  rowSpacing?: number;
  /** Outer padding around the laid-out content. */
  padding?: number;
}

export const DEFAULT_CORRIDOR_LAYOUT: Required<CorridorLayoutOptions> = {
  columnSpacing: 180,
  rowSpacing: 80,
  padding: 40,
};

const REJECTION_RE = /reject|revise|fail/i;

function classifyStatus(exec: StepExecution): CorridorNodeStatus {
  if (exec.status === "failed") return "failed";
  if (exec.step_name && REJECTION_RE.test(exec.step_name)) return "failed";
  if (exec.status === "in_progress") return "active";
  return "done";
}

/**
 * DFS-order columns rooted at `rootTaskId`. Tasks present in `executions` but
 * unreachable from the root are appended at the end so they still appear.
 */
function orderTaskColumns(
  rootTaskId: string,
  tasksById: Map<string, Task>,
  taskIdsWithExecutions: Set<string>
): { taskId: string; title: string | null }[] {
  const childrenByParent = new Map<string, string[]>();
  for (const t of tasksById.values()) {
    if (t.parent_id) {
      const list = childrenByParent.get(t.parent_id) ?? [];
      list.push(t.id);
      childrenByParent.set(t.parent_id, list);
    }
  }

  const ordered: { taskId: string; title: string | null }[] = [];
  const visited = new Set<string>();

  function visit(taskId: string): void {
    if (visited.has(taskId)) return;
    visited.add(taskId);
    if (taskIdsWithExecutions.has(taskId)) {
      ordered.push({ taskId, title: tasksById.get(taskId)?.title ?? null });
    }
    for (const kid of childrenByParent.get(taskId) ?? []) visit(kid);
  }

  visit(rootTaskId);

  for (const taskId of taskIdsWithExecutions) {
    if (!visited.has(taskId)) {
      ordered.push({ taskId, title: tasksById.get(taskId)?.title ?? null });
    }
  }

  return ordered;
}

/**
 * Build the corridor DAG layout for a subtree.
 *
 * Pure function: identical inputs yield identical outputs, with no random
 * tie-breaks. Tests assert against the returned positions directly.
 */
export function computeCorridorLayout(
  rootTaskId: string,
  executions: readonly StepExecution[],
  tasks: readonly Task[],
  options: CorridorLayoutOptions = {}
): CorridorLayout {
  const { columnSpacing, rowSpacing, padding } = {
    ...DEFAULT_CORRIDOR_LAYOUT,
    ...options,
  };

  const tasksById = new Map<string, Task>();
  for (const t of tasks) tasksById.set(t.id, t);

  const taskIdsWithExecutions = new Set<string>();
  for (const e of executions) {
    if (e.task_id) taskIdsWithExecutions.add(e.task_id);
  }

  const orderedTasks = orderTaskColumns(
    rootTaskId,
    tasksById,
    taskIdsWithExecutions
  );
  const columnByTaskId = new Map<string, number>();
  orderedTasks.forEach((t, i) => columnByTaskId.set(t.taskId, i));

  // Group executions per task and sort chronologically (stable secondary on id).
  const execsByTask = new Map<string, StepExecution[]>();
  for (const e of executions) {
    if (!e.task_id || !e.id) continue;
    const list = execsByTask.get(e.task_id) ?? [];
    list.push(e);
    execsByTask.set(e.task_id, list);
  }
  for (const list of execsByTask.values()) {
    list.sort((a, b) => {
      const am = safeMs(a.started_at) ?? 0;
      const bm = safeMs(b.started_at) ?? 0;
      if (am !== bm) return am - bm;
      return (a.id ?? "").localeCompare(b.id ?? "");
    });
  }

  const nodes: CorridorNode[] = [];
  const nodeByExecutionId = new Map<string, CorridorNode>();

  for (const { taskId } of orderedTasks) {
    const list = execsByTask.get(taskId) ?? [];
    const column = columnByTaskId.get(taskId) ?? 0;
    list.forEach((e, row) => {
      const id = `n-${e.id}`;
      const node: CorridorNode = {
        id,
        executionId: e.id ?? "",
        taskId,
        taskRunId: e.task_run_id ?? null,
        stepName: e.step_name ?? null,
        status: classifyStatus(e),
        startedAtMs: safeMs(e.started_at),
        column,
        row,
        x: padding + column * columnSpacing,
        y: padding + row * rowSpacing,
      };
      nodes.push(node);
      if (e.id) nodeByExecutionId.set(e.id, node);
    });
  }

  const edges: CorridorEdge[] = [];

  // Transition edges: consecutive executions within a task.
  for (const list of execsByTask.values()) {
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1];
      const curr = list[i];
      if (!prev.id || !curr.id) continue;
      edges.push({
        id: `e-tr-${prev.id}-${curr.id}`,
        kind: "transition",
        fromNodeId: `n-${prev.id}`,
        toNodeId: `n-${curr.id}`,
      });
    }
  }

  // Delegation edges: for each non-root task, find its first execution and the
  // most recent ancestor-task execution that started at or before it.
  for (const { taskId } of orderedTasks) {
    if (taskId === rootTaskId) continue;
    const childExecs = execsByTask.get(taskId) ?? [];
    const childFirst = childExecs[0];
    if (!childFirst?.id) continue;
    const childMs = safeMs(childFirst.started_at);

    let parentNode: CorridorNode | null = null;
    let parentMs = -Infinity;
    const seen = new Set<string>();
    let ancestorId = tasksById.get(taskId)?.parent_id ?? null;
    while (ancestorId && !seen.has(ancestorId)) {
      seen.add(ancestorId);
      for (const ae of execsByTask.get(ancestorId) ?? []) {
        const ms = safeMs(ae.started_at);
        if (ms === null) continue;
        if (childMs !== null && ms > childMs) continue;
        if (ms > parentMs && ae.id) {
          const n = nodeByExecutionId.get(ae.id);
          if (n) {
            parentNode = n;
            parentMs = ms;
          }
        }
      }
      ancestorId = tasksById.get(ancestorId)?.parent_id ?? null;
    }

    if (parentNode) {
      edges.push({
        id: `e-dl-${parentNode.executionId}-${childFirst.id}`,
        kind: "delegation",
        fromNodeId: parentNode.id,
        toNodeId: `n-${childFirst.id}`,
      });
    }
  }

  const lanes: CorridorLane[] = orderedTasks.map((t, i) => ({
    laneId: t.taskId,
    taskId: t.taskId,
    taskRunId: null,
    title: t.title,
    column: i,
    x: padding + i * columnSpacing,
    nodeCount: execsByTask.get(t.taskId)?.length ?? 0,
  }));

  const maxRow = nodes.reduce((m, n) => (n.row > m ? n.row : m), 0);
  const width =
    orderedTasks.length === 0
      ? padding * 2
      : padding * 2 + (orderedTasks.length - 1) * columnSpacing;
  const height = padding * 2 + maxRow * rowSpacing;

  return { nodes, edges, lanes, width, height };
}

// Build a corridor layout from explicit TaskRun lineage.
// Orphan executions (no task_run_id) are not rendered here; route them
// through computeCorridorLayout via projection.orphanExecutions instead.
export function computeCorridorLayoutFromProjection(
  projection: TaskRunTraceProjection,
  options: CorridorLayoutOptions = {}
): CorridorLayout {
  const { columnSpacing, rowSpacing, padding } = {
    ...DEFAULT_CORRIDOR_LAYOUT,
    ...options,
  };

  const orderedRuns = projection.orderedRuns;

  const nodes: CorridorNode[] = [];
  const nodeByExecutionId = new Map<string, CorridorNode>();
  const lanes: CorridorLane[] = [];

  orderedRuns.forEach((node, column) => {
    const lane: CorridorLane = {
      laneId: node.run.id,
      taskId: node.run.task_id,
      taskRunId: node.run.id,
      title: node.task?.title ?? null,
      column,
      x: padding + column * columnSpacing,
      nodeCount: node.executions.length,
    };
    lanes.push(lane);

    node.executions.forEach((e, row) => {
      if (!e.id) return;
      const id = `n-${e.id}`;
      const corridorNode: CorridorNode = {
        id,
        executionId: e.id,
        taskId: node.run.task_id,
        taskRunId: node.run.id,
        stepName: e.step_name ?? null,
        status: classifyStatus(e),
        startedAtMs: safeMs(e.started_at),
        column,
        row,
        x: lane.x,
        y: padding + row * rowSpacing,
      };
      nodes.push(corridorNode);
      nodeByExecutionId.set(e.id, corridorNode);
    });
  });

  const edges: CorridorEdge[] = [];

  // Transition edges: consecutive executions within a run.
  for (const node of orderedRuns) {
    for (let i = 1; i < node.executions.length; i += 1) {
      const prev = node.executions[i - 1];
      const curr = node.executions[i];
      if (!prev.id || !curr.id) continue;
      edges.push({
        id: `e-tr-${prev.id}-${curr.id}`,
        kind: "transition",
        fromNodeId: `n-${prev.id}`,
        toNodeId: `n-${curr.id}`,
      });
    }
  }

  // Delegation edges: explicit run-to-run lineage.
  for (const edge of projection.delegationEdges) {
    const childNode = projection.runsById.get(edge.childRunId);
    const childFirst = childNode?.executions[0];
    if (!childFirst?.id) continue;
    const parentExec = resolveParentExecution(projection, edge);
    if (!parentExec?.id) continue;
    const fromCorridor = nodeByExecutionId.get(parentExec.id);
    const toCorridor = nodeByExecutionId.get(childFirst.id);
    if (!fromCorridor || !toCorridor) continue;
    edges.push({
      id: `e-dl-${parentExec.id}-${childFirst.id}`,
      kind: "delegation",
      fromNodeId: fromCorridor.id,
      toNodeId: toCorridor.id,
    });
  }

  const maxRow = nodes.reduce((m, n) => (n.row > m ? n.row : m), 0);
  const width =
    orderedRuns.length === 0
      ? padding * 2
      : padding * 2 + (orderedRuns.length - 1) * columnSpacing;
  const height = padding * 2 + maxRow * rowSpacing;

  return { nodes, edges, lanes, width, height };
}
