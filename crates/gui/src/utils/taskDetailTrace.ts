import { useDebugStore } from "../stores/debugStore";

export type TaskDetailTraceDetails = Record<
  string,
  boolean | number | string | null | undefined
>;

interface TaskDetailTrace {
  traceId: string;
  taskId: string;
  source: string;
  startedAt: number;
  startMark: string;
  phases: Set<string>;
  renderStats: {
    taskTreeRowRenders: number;
    taskRunObserverSlots: number;
  };
}

const activeTraces = new Map<string, TaskDetailTrace>();
let nextTraceId = 0;

export function taskDetailTraceNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

function safePerformanceMark(name: string): void {
  if (typeof performance === "undefined") return;
  try {
    performance.mark(name);
  } catch {
    // Diagnostics must never interfere with opening a task.
  }
}

function recordPhase(
  trace: TaskDetailTrace,
  phase: string,
  details?: TaskDetailTraceDetails
): string {
  const timestamp = taskDetailTraceNow();
  const markName = `${trace.startMark}:${phase}`;
  safePerformanceMark(markName);

  if (typeof performance !== "undefined") {
    try {
      performance.measure(markName, trace.startMark, markName);
    } catch {
      // A missing performance mark should not affect the diagnostic log.
    }
  }

  const event = {
    traceId: trace.traceId,
    taskId: trace.taskId,
    source: trace.source,
    phase,
    elapsedMs: roundMilliseconds(timestamp - trace.startedAt),
    ...details,
  };

  console.debug("[TaskDetailTrace]", event);
  useDebugStore.getState().addLog({
    timestamp: Date.now(),
    level: "DEBUG",
    crateName: "gui-webview",
    target: "task-detail-trace",
    message: `[TaskDetailTrace] ${JSON.stringify(event)}`,
  });

  return trace.traceId;
}

/** Start a new selection-to-render trace for a task. */
export function startTaskDetailTrace(taskId: string, source: string): string {
  const traceId = `task-detail-${++nextTraceId}`;
  const startMark = `vertebrae:task-detail:${traceId}:selection`;
  const trace: TaskDetailTrace = {
    traceId,
    taskId,
    source,
    startedAt: taskDetailTraceNow(),
    startMark,
    phases: new Set(),
    renderStats: {
      taskTreeRowRenders: 0,
      taskRunObserverSlots: 0,
    },
  };

  activeTraces.set(taskId, trace);
  safePerformanceMark(startMark);
  recordPhase(trace, "selection-start", {
    debugPanelOpen: useDebugStore.getState().debugPanelOpen,
  });
  return traceId;
}

/** Count task-tree work without emitting one log entry per rendered row. */
export function noteTaskDetailTreeRowRender(
  taskId: string,
  taskRunObserverSlots: number
): void {
  const trace = activeTraces.get(taskId);
  if (!trace) return;
  trace.renderStats.taskTreeRowRenders += 1;
  trace.renderStats.taskRunObserverSlots += taskRunObserverSlots;
}

/** Record the first React Profiler sample for a named task-detail surface. */
export function traceTaskDetailProfilerRender(
  taskId: string | null | undefined,
  profilerId: string,
  profilerPhase: string,
  actualDurationMs: number,
  baseDurationMs: number
): string | null {
  if (!taskId) return null;
  const trace = activeTraces.get(taskId);
  if (!trace) return null;

  const details: TaskDetailTraceDetails = {
    profilerPhase,
    actualDurationMs: roundMilliseconds(actualDurationMs),
    baseDurationMs: roundMilliseconds(baseDurationMs),
  };
  if (profilerId === "task-tree") {
    details.taskTreeRowRenders = trace.renderStats.taskTreeRowRenders;
    details.taskRunObserverSlots = trace.renderStats.taskRunObserverSlots;
  }

  return traceTaskDetailPhaseOnce(taskId, `${profilerId}-profiler`, details);
}

/** Ensure panels opened from another surface still get a correlated trace. */
export function ensureTaskDetailTrace(taskId: string, source: string): string {
  return (
    activeTraces.get(taskId)?.traceId ?? startTaskDetailTrace(taskId, source)
  );
}

export function getTaskDetailTraceId(taskId: string): string | null {
  return activeTraces.get(taskId)?.traceId ?? null;
}

export function traceTaskDetailPhase(
  taskId: string,
  phase: string,
  details?: TaskDetailTraceDetails
): string | null {
  const trace = activeTraces.get(taskId);
  return trace ? recordPhase(trace, phase, details) : null;
}

/** Record a lifecycle phase once for a trace, even under React StrictMode. */
export function traceTaskDetailPhaseOnce(
  taskId: string,
  phase: string,
  details?: TaskDetailTraceDetails
): string | null {
  const trace = activeTraces.get(taskId);
  if (!trace || trace.phases.has(phase)) return trace?.traceId ?? null;
  trace.phases.add(phase);
  return recordPhase(trace, phase, details);
}

export function finishTaskDetailTrace(
  taskId: string,
  details?: TaskDetailTraceDetails
): string | null {
  const trace = activeTraces.get(taskId);
  if (!trace) return null;
  const traceId = recordPhase(trace, "content-painted", details);
  activeTraces.delete(taskId);
  return traceId;
}
