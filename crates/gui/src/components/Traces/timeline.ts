import type { SessionLog, StepExecution, Task } from "../../bindings";
import {
  mergeExecutionEvents,
  type TaggedConversationEvent,
} from "../../types/conversation";
import {
  resolveParentExecution,
  type TaskRunTraceProjection,
} from "./taskRunTrace";
import { safeMs } from "./timeUtils";

export type LaneKind = "threshold" | "tool" | "main" | "delegation";

export type ThresholdMarkerKind =
  | "transition"
  | "retry"
  | "rejection"
  | "approval"
  | "model_fallback"
  | "execution_start"
  | "execution_end";

export interface ThresholdMarker {
  lane: "threshold";
  kind: ThresholdMarkerKind;
  /** Normalized [0, 1] x position. */
  x: number;
  timestampMs: number;
  executionId: string;
  taskId: string;
  fromStep: string | null;
  toStep: string | null;
  label: string;
}

export interface ToolMarker {
  lane: "tool";
  kind: "tool_use" | "tool_result";
  x: number;
  timestampMs: number;
  executionId: string;
  taskId: string;
  toolId: string;
  toolName: string;
  isError: boolean;
}

export interface MainMarker {
  lane: "main";
  kind: "message";
  x: number;
  timestampMs: number;
  executionId: string;
  taskId: string;
  rowIndex: number;
}

export interface DelegationEdge {
  lane: "delegation";
  x: number;
  timestampMs: number;
  parentTaskId: string;
  childTaskId: string;
  /**
   * Parent TaskRun id when the edge was derived from explicit run lineage.
   * Null for legacy task-hierarchy delegation edges.
   */
  parentTaskRunId: string | null;
  /**
   * Child TaskRun id when the edge was derived from explicit run lineage.
   * Null for legacy task-hierarchy delegation edges.
   */
  childTaskRunId: string | null;
  parentRowIndex: number;
  childRowIndex: number;
  childLevel: string | null;
}

export type TimelineMarker = ThresholdMarker | ToolMarker | MainMarker;

export interface MainRow {
  /** Stable row key. For run-aware projections this is the TaskRun id. */
  rowKey: string;
  taskId: string;
  /** TaskRun id when the row is keyed on a TaskRun; null for legacy rows. */
  taskRunId: string | null;
  title: string | null;
  level: string | null;
  /** Depth from root (0 = root). */
  depth: number;
  index: number;
}

export interface TimelineProjection {
  minMs: number | null;
  maxMs: number | null;
  spanMs: number;
  mainRows: MainRow[];
  thresholds: ThresholdMarker[];
  tools: ToolMarker[];
  main: MainMarker[];
  /** main markers bucketed by rowIndex for O(1) per-row rendering. */
  mainByRow: MainMarker[][];
  delegations: DelegationEdge[];
  taggedEvents: TaggedConversationEvent[];
}

const REJECTION_RE = /reject|revise|fail/i;
const APPROVAL_RE = /approve|done|complete|merge/i;

function buildMainRows(
  rootTaskId: string,
  tasks: readonly Task[],
  taskIdsWithExecutions: Set<string>
): MainRow[] {
  const tasksById = new Map<string, Task>();
  for (const t of tasks) tasksById.set(t.id, t);

  const childrenByParent = new Map<string, string[]>();
  for (const t of tasks) {
    const pid = t.parent_id ?? null;
    if (pid !== null) {
      const list = childrenByParent.get(pid) ?? [];
      list.push(t.id);
      childrenByParent.set(pid, list);
    }
  }

  const rows: MainRow[] = [];
  const visited = new Set<string>();

  function visit(taskId: string, depth: number): void {
    if (visited.has(taskId)) return;
    visited.add(taskId);
    if (taskIdsWithExecutions.has(taskId)) {
      const t = tasksById.get(taskId);
      rows.push({
        rowKey: taskId,
        taskId,
        taskRunId: null,
        title: t?.title ?? null,
        level: t?.level ?? null,
        depth,
        index: rows.length,
      });
    }
    const kids = childrenByParent.get(taskId) ?? [];
    for (const kid of kids) visit(kid, depth + 1);
  }

  visit(rootTaskId, 0);

  // Tasks with executions but unreachable from root — append rather than drop.
  for (const taskId of taskIdsWithExecutions) {
    if (!visited.has(taskId)) {
      const t = tasksById.get(taskId);
      rows.push({
        rowKey: taskId,
        taskId,
        taskRunId: null,
        title: t?.title ?? null,
        level: t?.level ?? null,
        depth: 0,
        index: rows.length,
      });
    }
  }

  return rows;
}

export function buildTimelineProjection(
  rootTaskId: string,
  executions: readonly StepExecution[],
  tasks: readonly Task[],
  logsByExecutionId: Readonly<Record<string, SessionLog[]>>
): TimelineProjection {
  let minMs: number | null = null;
  let maxMs: number | null = null;
  const observe = (ms: number): void => {
    if (minMs === null || ms < minMs) minMs = ms;
    if (maxMs === null || ms > maxMs) maxMs = ms;
  };

  const taskIdsWithExecutions = new Set<string>();
  for (const exec of executions) {
    if (exec.task_id) taskIdsWithExecutions.add(exec.task_id);
    const startMs = safeMs(exec.started_at);
    if (startMs !== null) observe(startMs);
    const endMs = safeMs(exec.completed_at);
    if (endMs !== null) observe(endMs);
  }

  const tagged = mergeExecutionEvents(executions, logsByExecutionId);
  for (const t of tagged) {
    const ms = safeMs(t.event.timestamp);
    if (ms !== null) observe(ms);
  }

  const spanMs = minMs !== null && maxMs !== null ? maxMs - minMs : 0;
  const xOf = (ms: number): number => {
    if (minMs === null || spanMs <= 0) return 0;
    return (ms - minMs) / spanMs;
  };

  const mainRows = buildMainRows(rootTaskId, tasks, taskIdsWithExecutions);
  const rowIndexByTaskId = new Map<string, number>();
  for (const row of mainRows) rowIndexByTaskId.set(row.taskId, row.index);

  const thresholds: ThresholdMarker[] = [];
  const execsSorted = [...executions]
    .filter((e) => !!e.id && safeMs(e.started_at) !== null)
    .sort((a, b) => (safeMs(a.started_at) ?? 0) - (safeMs(b.started_at) ?? 0));

  const lastExecByTask = new Map<string, StepExecution>();
  const lastModelByTask = new Map<string, string | null>();

  for (const exec of execsSorted) {
    const startMs = safeMs(exec.started_at);
    if (startMs === null) continue;
    const x = xOf(startMs);
    const taskId = exec.task_id ?? "";
    const stepName = exec.step_name ?? null;
    const prev = lastExecByTask.get(taskId);

    if (prev) {
      const prevStep = prev.step_name ?? null;
      let kind: ThresholdMarkerKind = "transition";
      if (prevStep && stepName && prevStep === stepName) {
        kind = "retry";
      } else if (stepName && REJECTION_RE.test(stepName)) {
        kind = "rejection";
      } else if (stepName && APPROVAL_RE.test(stepName)) {
        kind = "approval";
      }
      thresholds.push({
        lane: "threshold",
        kind,
        x,
        timestampMs: startMs,
        executionId: exec.id ?? "",
        taskId,
        fromStep: prevStep,
        toStep: stepName,
        label: `${prevStep ?? "?"} → ${stepName ?? "?"}`,
      });
    } else {
      thresholds.push({
        lane: "threshold",
        kind: "execution_start",
        x,
        timestampMs: startMs,
        executionId: exec.id ?? "",
        taskId,
        fromStep: null,
        toStep: stepName,
        label: stepName ?? "start",
      });
    }

    const lastModel = lastModelByTask.get(taskId) ?? null;
    if (lastModel && exec.model && lastModel !== exec.model) {
      thresholds.push({
        lane: "threshold",
        kind: "model_fallback",
        x,
        timestampMs: startMs,
        executionId: exec.id ?? "",
        taskId,
        fromStep: prev?.step_name ?? null,
        toStep: stepName,
        label: `${lastModel} → ${exec.model}`,
      });
    }

    lastExecByTask.set(taskId, exec);
    if (exec.model) lastModelByTask.set(taskId, exec.model);
  }

  const tools: ToolMarker[] = [];
  const main: MainMarker[] = [];
  const mainByRow: MainMarker[][] = mainRows.map(() => []);

  for (const t of tagged) {
    const ms = safeMs(t.event.timestamp);
    if (ms === null) continue;
    const x = xOf(ms);
    const event = t.event;

    if (event.kind === "tool_call") {
      tools.push({
        lane: "tool",
        kind: "tool_use",
        x,
        timestampMs: ms,
        executionId: t.executionId,
        taskId: t.taskId,
        toolId: event.toolId,
        toolName: event.toolName,
        isError: false,
      });
    } else if (event.kind === "tool_result") {
      tools.push({
        lane: "tool",
        kind: "tool_result",
        x,
        timestampMs: ms,
        executionId: t.executionId,
        taskId: t.taskId,
        toolId: event.toolUseId,
        toolName: "",
        isError: event.isError,
      });
    } else if (event.kind === "thinking") {
      const rowIndex = rowIndexByTaskId.get(t.taskId);
      if (rowIndex !== undefined) {
        const marker: MainMarker = {
          lane: "main",
          kind: "message",
          x,
          timestampMs: ms,
          executionId: t.executionId,
          taskId: t.taskId,
          rowIndex,
        };
        main.push(marker);
        mainByRow[rowIndex].push(marker);
      }
    }
  }

  const levelByTaskId = new Map<string, string | null>();
  for (const t of tasks) levelByTaskId.set(t.id, t.level);

  const delegations: DelegationEdge[] = [];
  let prevExec: StepExecution | null = null;
  for (const exec of execsSorted) {
    if (
      prevExec &&
      exec.task_id &&
      prevExec.task_id &&
      exec.task_id !== prevExec.task_id
    ) {
      const parentRow = rowIndexByTaskId.get(prevExec.task_id);
      const childRow = rowIndexByTaskId.get(exec.task_id);
      if (
        parentRow !== undefined &&
        childRow !== undefined &&
        childRow !== parentRow
      ) {
        const ms = safeMs(exec.started_at) ?? 0;
        delegations.push({
          lane: "delegation",
          x: xOf(ms),
          timestampMs: ms,
          parentTaskId: prevExec.task_id,
          childTaskId: exec.task_id,
          parentTaskRunId: null,
          childTaskRunId: null,
          parentRowIndex: parentRow,
          childRowIndex: childRow,
          childLevel: levelByTaskId.get(exec.task_id) ?? null,
        });
      }
    }
    prevExec = exec;
  }

  return {
    minMs,
    maxMs,
    spanMs,
    mainRows,
    thresholds,
    tools,
    main,
    mainByRow,
    delegations,
    taggedEvents: tagged,
  };
}

// Build a timeline projection from explicit TaskRun lineage. Orphan
// executions (no task_run_id) are skipped here; route them through
// buildTimelineProjection via projection.orphanExecutions instead.
export function buildTimelineProjectionFromProjection(
  projection: TaskRunTraceProjection,
  logsByExecutionId: Readonly<Record<string, SessionLog[]>>
): TimelineProjection {
  const orderedRuns = projection.orderedRuns;

  // Flatten executions that belong to known runs; skip orphans.
  const runExecutions: StepExecution[] = [];
  for (const node of orderedRuns) {
    for (const e of node.executions) runExecutions.push(e);
  }

  let minMs: number | null = null;
  let maxMs: number | null = null;
  const observe = (ms: number): void => {
    if (minMs === null || ms < minMs) minMs = ms;
    if (maxMs === null || ms > maxMs) maxMs = ms;
  };

  for (const exec of runExecutions) {
    const startMs = safeMs(exec.started_at);
    if (startMs !== null) observe(startMs);
    const endMs = safeMs(exec.completed_at);
    if (endMs !== null) observe(endMs);
  }

  const tagged = mergeExecutionEvents(runExecutions, logsByExecutionId);
  for (const t of tagged) {
    const ms = safeMs(t.event.timestamp);
    if (ms !== null) observe(ms);
  }

  const spanMs = minMs !== null && maxMs !== null ? maxMs - minMs : 0;
  const xOf = (ms: number): number => {
    if (minMs === null || spanMs <= 0) return 0;
    return (ms - minMs) / spanMs;
  };

  // Rows: one per TaskRun, in DFS order, with depth from the projection.
  const mainRows: MainRow[] = orderedRuns.map((node, i) => ({
    rowKey: node.run.id,
    taskId: node.run.task_id,
    taskRunId: node.run.id,
    title: node.task?.title ?? null,
    level: node.task?.level ?? null,
    depth: node.depth,
    index: i,
  }));
  const rowIndexByRunId = new Map<string, number>();
  for (const row of mainRows) {
    if (row.taskRunId) rowIndexByRunId.set(row.taskRunId, row.index);
  }

  // Thresholds: per-run consecutive transitions / retries / model fallbacks.
  const thresholds: ThresholdMarker[] = [];
  for (const node of orderedRuns) {
    let lastModel: string | null = null;
    for (let i = 0; i < node.executions.length; i += 1) {
      const exec = node.executions[i];
      const startMs = safeMs(exec.started_at);
      if (startMs === null) continue;
      const x = xOf(startMs);
      const stepName = exec.step_name ?? null;
      const taskId = exec.task_id ?? node.run.task_id;
      const prev = i > 0 ? node.executions[i - 1] : null;
      if (prev) {
        const prevStep = prev.step_name ?? null;
        let kind: ThresholdMarkerKind = "transition";
        if (prevStep && stepName && prevStep === stepName) {
          kind = "retry";
        } else if (stepName && REJECTION_RE.test(stepName)) {
          kind = "rejection";
        } else if (stepName && APPROVAL_RE.test(stepName)) {
          kind = "approval";
        }
        thresholds.push({
          lane: "threshold",
          kind,
          x,
          timestampMs: startMs,
          executionId: exec.id ?? "",
          taskId,
          fromStep: prevStep,
          toStep: stepName,
          label: `${prevStep ?? "?"} → ${stepName ?? "?"}`,
        });
      } else {
        thresholds.push({
          lane: "threshold",
          kind: "execution_start",
          x,
          timestampMs: startMs,
          executionId: exec.id ?? "",
          taskId,
          fromStep: null,
          toStep: stepName,
          label: stepName ?? "start",
        });
      }
      if (lastModel && exec.model && lastModel !== exec.model) {
        thresholds.push({
          lane: "threshold",
          kind: "model_fallback",
          x,
          timestampMs: startMs,
          executionId: exec.id ?? "",
          taskId,
          fromStep: prev?.step_name ?? null,
          toStep: stepName,
          label: `${lastModel} → ${exec.model}`,
        });
      }
      if (exec.model) lastModel = exec.model;
    }
  }

  const { runIdByExecutionId } = projection;

  const tools: ToolMarker[] = [];
  const main: MainMarker[] = [];
  const mainByRow: MainMarker[][] = mainRows.map(() => []);

  for (const t of tagged) {
    const ms = safeMs(t.event.timestamp);
    if (ms === null) continue;
    const x = xOf(ms);
    const event = t.event;
    if (event.kind === "tool_call") {
      tools.push({
        lane: "tool",
        kind: "tool_use",
        x,
        timestampMs: ms,
        executionId: t.executionId,
        taskId: t.taskId,
        toolId: event.toolId,
        toolName: event.toolName,
        isError: false,
      });
    } else if (event.kind === "tool_result") {
      tools.push({
        lane: "tool",
        kind: "tool_result",
        x,
        timestampMs: ms,
        executionId: t.executionId,
        taskId: t.taskId,
        toolId: event.toolUseId,
        toolName: "",
        isError: event.isError,
      });
    } else if (event.kind === "thinking") {
      const runId = runIdByExecutionId.get(t.executionId);
      const rowIndex = runId !== undefined ? rowIndexByRunId.get(runId) : undefined;
      if (rowIndex !== undefined) {
        const marker: MainMarker = {
          lane: "main",
          kind: "message",
          x,
          timestampMs: ms,
          executionId: t.executionId,
          taskId: t.taskId,
          rowIndex,
        };
        main.push(marker);
        mainByRow[rowIndex].push(marker);
      }
    }
  }

  // Delegation edges: explicit run-to-run lineage. Anchor x to either the
  // child's first execution or the resolved trigger execution time.
  const delegations: DelegationEdge[] = [];
  for (const edge of projection.delegationEdges) {
    const childNode = projection.runsById.get(edge.childRunId);
    const parentNode = projection.runsById.get(edge.parentRunId);
    if (!childNode || !parentNode) continue;
    const parentRow = rowIndexByRunId.get(edge.parentRunId);
    const childRow = rowIndexByRunId.get(edge.childRunId);
    if (parentRow === undefined || childRow === undefined) continue;
    const childFirst = childNode.executions[0];
    const triggerExec = resolveParentExecution(projection, edge);
    const anchorMs =
      safeMs(childFirst?.started_at) ?? safeMs(triggerExec?.started_at) ?? 0;
    delegations.push({
      lane: "delegation",
      x: xOf(anchorMs),
      timestampMs: anchorMs,
      parentTaskId: parentNode.run.task_id,
      childTaskId: childNode.run.task_id,
      parentTaskRunId: edge.parentRunId,
      childTaskRunId: edge.childRunId,
      parentRowIndex: parentRow,
      childRowIndex: childRow,
      childLevel: childNode.task?.level ?? null,
    });
  }

  return {
    minMs,
    maxMs,
    spanMs,
    mainRows,
    thresholds,
    tools,
    main,
    mainByRow,
    delegations,
    taggedEvents: tagged,
  };
}
