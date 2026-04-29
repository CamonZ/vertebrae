import type { SessionLog, StepExecution, Task } from "../../bindings";
import {
  mergeExecutionEvents,
  type TaggedConversationEvent,
} from "../../types/conversation";

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
  parentRowIndex: number;
  childRowIndex: number;
}

export type TimelineMarker = ThresholdMarker | ToolMarker | MainMarker;

export interface MainRow {
  taskId: string;
  title: string | null;
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
        taskId,
        title: t?.title ?? null,
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
        taskId,
        title: t?.title ?? null,
        depth: 0,
        index: rows.length,
      });
    }
  }

  return rows;
}

function safeMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
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
          parentRowIndex: parentRow,
          childRowIndex: childRow,
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
