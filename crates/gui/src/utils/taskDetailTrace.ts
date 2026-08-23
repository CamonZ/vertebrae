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
  };

  activeTraces.set(taskId, trace);
  safePerformanceMark(startMark);
  recordPhase(trace, "selection-start");
  return traceId;
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
