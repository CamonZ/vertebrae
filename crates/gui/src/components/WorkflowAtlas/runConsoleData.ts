/* ──────────────────────────────────────────────────────────────────
   Workflow Atlas · Run Console — pure helpers.

   The Run Console reads the live task list (the *work*) and projects it onto the
   workflow machine (the *map*). These builders are split out so the tab split,
   the per-row mini-pipeline, and the runtime clock can be unit-tested without
   mounting React.

   Ported from docs/design/run-console.jsx (currentStep / Pipe / fmtElapsed).
   ────────────────────────────────────────────────────────────────── */
import type { PipelineSummary, Task } from "../../bindings";
import { deriveActiveTaskRuns } from "../../utils/runState";
import { kindFor } from "./adapter/buildAtlasModel";
import type { Kind } from "./layout/types";

/** A workflow task and its (optional) active run, ready for a console row. */
export interface RunConsoleRow {
  task: Task;
  /** ISO 8601 start of the active run, or null when not running. */
  startedAt: string | null;
}

/** The two console buckets: live work vs. launchable work. */
export interface RunConsoleSplit {
  running: RunConsoleRow[];
  ready: RunConsoleRow[];
}

/** One segment of a row's mini-pipeline (a workflow step projected to a state). */
export interface PipelineSegment {
  kind: Kind;
  /**
   * `done` earlier steps, `queued` later ones. The task's current step is
   * `running` only when a run is actually active (it pulses); for a parked task
   * it is `current` — a static "you are here" marker that never animates.
   */
  state: "done" | "running" | "current" | "queued";
}

/**
 * Split tasks into Running / Ready buckets.
 *
 * Running = tasks with an active TaskRun (queued / executing / waiting /
 * stopping), via `deriveActiveTaskRuns` so the predicate matches the rest of the
 * app. Ready = tasks that have a workflow but no active run — the launchable
 * head. Tasks without a workflow are not launchable and are dropped from both.
 */
export function splitRunConsole(tasks: Task[]): RunConsoleSplit {
  const activeByTaskId = new Map(
    deriveActiveTaskRuns(tasks, { sortNewestFirst: true }).map((a) => [
      a.task.id,
      a.taskRun,
    ]),
  );

  const running: RunConsoleRow[] = [];
  const ready: RunConsoleRow[] = [];

  for (const task of tasks) {
    const activeRun = activeByTaskId.get(task.id);
    if (activeRun) {
      running.push({
        task,
        startedAt: activeRun.started_at ?? activeRun.inserted_at ?? null,
      });
      continue;
    }
    // Ready = a runnable workflow task that the daemon is not driving.
    if (task.workflow_id) {
      ready.push({ task, startedAt: null });
    }
  }

  // Keep Running newest-first (already sorted) and Ready in list order.
  return { running, ready };
}

/**
 * Build a task's mini-pipeline: its workflow's steps in order, projected to a
 * state relative to the task's `current_step_id` — earlier steps `done`, later
 * steps `queued`. The current step is `running` (it pulses) only when
 * `isRunning` is set — i.e. the task actually has an active run; otherwise it is
 * `current`, a static marker so a parked Ready task does not flash. When the
 * task is not at a known step (no `current_step_id`, or it sits before the first
 * step), every segment reads `queued`.
 */
export function miniPipeline(
  task: Task,
  summary: PipelineSummary | null,
  isRunning = false,
): PipelineSegment[] {
  if (!summary || !task.workflow_id) return [];
  const wf = summary.workflows.find((w) => w.id === task.workflow_id);
  if (!wf) return [];

  const ordered = wf.workflow_steps
    .slice()
    .sort((a, b) => a.step_order - b.step_order);
  if (ordered.length === 0) return [];

  const currentIdx = task.current_step_id
    ? ordered.findIndex((s) => s.id === task.current_step_id)
    : -1;

  return ordered.map((step, i) => {
    const kind = kindFor(step);
    let state: PipelineSegment["state"];
    if (currentIdx < 0) state = "queued";
    else if (i < currentIdx) state = "done";
    else if (i === currentIdx) state = isRunning ? "running" : "current";
    else state = "queued";
    return { kind, state };
  });
}

/** Format an elapsed millisecond span as a compact "1h 2m" / "3m 4s" / "5s". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Elapsed runtime since an ISO start, relative to `now` (ms epoch). Null-safe. */
export function runtimeSince(
  startedAt: string | null,
  now: number,
): string | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;
  return formatElapsed(now - start);
}
