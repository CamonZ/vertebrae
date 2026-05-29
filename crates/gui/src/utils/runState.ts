import type {
  Task,
  TaskRun,
  TaskRunControls,
  TaskRunStatus,
} from "../bindings";

export interface ActiveTaskRun {
  task: Task;
  taskRun: TaskRun;
}

/**
 * Statuses that represent a TaskRun the daemon is actively driving (or about
 * to start driving). These are the runs that should suppress the Run button
 * and -- when also `stoppable` -- enable the Stop button.
 */
const ACTIVE_RUN_STATUSES: ReadonlySet<TaskRunStatus> = new Set([
  "queued",
  "executing",
  "waiting",
  "stopping",
]);

/**
 * Whether a TaskRun status is considered live work in progress on the server.
 *
 * `stopping` counts as active here so the row keeps showing a Stop chip even
 * after the user has clicked Stop and we are waiting for the orchestrator to
 * acknowledge -- it is not idle until it transitions to a terminal status.
 */
export function isActiveRunStatus(
  status: TaskRunStatus | null | undefined
): boolean {
  return status != null && ACTIVE_RUN_STATUSES.has(status);
}

export function deriveActiveTaskRuns(
  tasks: Task[],
  options: { includeStopping?: boolean; sortNewestFirst?: boolean } = {}
): ActiveTaskRun[] {
  const { includeStopping = true, sortNewestFirst = false } = options;
  const items: ActiveTaskRun[] = [];

  for (const task of tasks) {
    const taskRun = task.run_controls?.active_run;
    if (!taskRun || !isActiveRunStatus(taskRun.status)) continue;
    if (!includeStopping && taskRun.status === "stopping") continue;
    items.push({ task, taskRun });
  }

  if (!sortNewestFirst) return items;

  return items.sort((a, b) => {
    const aStarted = a.taskRun.started_at ?? a.taskRun.inserted_at ?? "";
    const bStarted = b.taskRun.started_at ?? b.taskRun.inserted_at ?? "";
    return bStarted.localeCompare(aStarted);
  });
}

/**
 * Compact, human-readable summary for the run state chip surfaced in
 * task lists, board cards, and detail headers.
 *
 * `tone` maps to the existing semantic palette (info/warning/success/error/...)
 * so callers stay decoupled from concrete tailwind classes.
 */
export interface RunStateChip {
  /** Short label suitable for a chip ("Queued", "Running", ...). */
  label: string;
  /** Underlying TaskRun status (or null when no run has ever been observed). */
  status: TaskRunStatus | null;
  /** Whether this run is still active (queued/executing/waiting/stopping). */
  isActive: boolean;
  /** Semantic tone hint for styling. */
  tone: "neutral" | "info" | "warning" | "success" | "error" | "muted";
}

type RunStateTone = RunStateChip["tone"];

function runStatusMeta(status: TaskRunStatus): {
  label: string;
  isActive: boolean;
  tone: RunStateTone;
} {
  const label = runStatusLabel(status);
  const isActive = isActiveRunStatus(status);

  switch (status) {
    case "queued":
    case "waiting":
      return { label, isActive, tone: "info" };
    case "executing":
    case "completed":
      return { label, isActive, tone: "success" };
    case "failed":
      return { label, isActive, tone: "error" };
    case "stopping":
    case "stopped":
      return { label, isActive, tone: "muted" };
    default:
      return { label, isActive, tone: "neutral" };
  }
}

export type HearthRunState =
  | "queued"
  | "running"
  | "waiting"
  | "stopping"
  | "stopped"
  | "completed"
  | "failed";

export interface HearthRunChipState {
  /** V2-facing state name used for stable `c-run-chip <state>` classes. */
  state: HearthRunState;
  /** Production status, retained for callers that need to reason in app terms. */
  status: TaskRunStatus;
  label: string;
  isActive: boolean;
  tone: RunStateChip["tone"];
}

export type HearthStateBreakdownVariant =
  | "done"
  | "running"
  | "waiting"
  | "queued";

export interface HearthStateBreakdown {
  done: number;
  running: number;
  waiting: number;
  queued: number;
}

export const EMPTY_HEARTH_STATE_BREAKDOWN: HearthStateBreakdown = {
  done: 0,
  running: 0,
  waiting: 0,
  queued: 0,
};

const TERMINAL_RUN_STATUSES: ReadonlySet<TaskRunStatus> = new Set([
  "stopped",
  "completed",
  "failed",
]);

export function taskRunStatusToHearthRunState(
  status: TaskRunStatus
): HearthRunState {
  return status === "executing" ? "running" : status;
}

export function deriveHearthRunChipState(
  status: TaskRunStatus | null | undefined,
  options: { includeTerminal?: boolean } = {}
): HearthRunChipState | null {
  if (!status) return null;
  if (TERMINAL_RUN_STATUSES.has(status) && !options.includeTerminal) {
    return null;
  }

  const meta = runStatusMeta(status);

  return {
    state: taskRunStatusToHearthRunState(status),
    status,
    ...meta,
  };
}

export function hearthBreakdownVariantForTask(
  task: Pick<Task, "completed_at" | "run_controls">
): HearthStateBreakdownVariant {
  const status = task.run_controls?.active_run?.status ?? null;
  if (task.completed_at || status === "completed") return "done";
  if (status === "executing") return "running";
  if (status === "waiting") return "waiting";
  return "queued";
}

export function deriveHearthStateBreakdown<
  T extends Pick<Task, "completed_at" | "run_controls">,
>(tasks: T[]): HearthStateBreakdown {
  return tasks.reduce<HearthStateBreakdown>(
    (counts, task) => {
      counts[hearthBreakdownVariantForTask(task)] += 1;
      return counts;
    },
    { ...EMPTY_HEARTH_STATE_BREAKDOWN }
  );
}

export function hasHearthStateBreakdown(
  breakdown: HearthStateBreakdown
): boolean {
  return (
    breakdown.done > 0 ||
    breakdown.running > 0 ||
    breakdown.waiting > 0 ||
    breakdown.queued > 0
  );
}

/**
 * Derive the run state chip strictly from `task.run_controls`.
 *
 * Returns `null` when the task has no `run_controls` payload at all
 * (legacy rows that the server has not yet annotated, or non-runnable tasks
 * with no workflow). Returns `null` for terminal runs unless the task is
 * currently selected -- callers can opt in with `includeTerminal`.
 */
export function deriveRunStateChip(
  task: Pick<Task, "run_controls">,
  options: { includeTerminal?: boolean } = {}
): RunStateChip | null {
  const controls = task.run_controls;
  if (!controls) return null;

  const activeRun = controls.active_run;
  if (!activeRun) return null;

  const status = activeRun.status;
  const active = isActiveRunStatus(status);
  if (!active && !options.includeTerminal) {
    return null;
  }

  const label = runStatusLabel(status);
  const meta = runStatusMeta(status);
  return { label, status, isActive: meta.isActive, tone: meta.tone };
}

/**
 * Derived Run/Stop button state for a task row or detail surface.
 *
 * Always falls back to safe defaults when the server has not provided
 * `run_controls` yet: Run is enabled iff the task has a workflow, Stop is
 * hidden, and `stopping` is treated as a transient state that disables both
 * controls.
 */
export interface RunControlsState {
  /** The active TaskRun on the server, if any. */
  activeRun: TaskRun | null;
  /** Whether the daemon is currently working on this task. */
  hasActiveRun: boolean;
  /** Server-derived: this task can be started right now. */
  runnable: boolean;
  /** Server-derived: an in-flight run can be asked to stop. */
  stoppable: boolean;
  /** Server-derived: the active run is in the `stopping` transition. */
  isStopping: boolean;
  /** Surface should show the Stop control (Stop or Cancel orchestration). */
  showStop: boolean;
  /** Surface should disable the Run control. */
  runDisabled: boolean;
  /** Surface should disable the Stop control. */
  stopDisabled: boolean;
}

export function runStatusLabel(
  status: TaskRunStatus | null | undefined
): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "executing":
      return "Running";
    case "waiting":
      return "Waiting";
    case "stopping":
      return "Stopping";
    case "stopped":
      return "Stopped";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return status ?? "Unknown";
  }
}

export interface RunChipStyles {
  bg: string;
  text: string;
  dot: string;
  pulse: boolean;
}

export function getRunChipStyles(chip: RunStateChip): RunChipStyles {
  switch (chip.tone) {
    case "warning":
      return {
        bg: "bg-warning/10",
        text: "text-warning",
        dot: "bg-warning",
        pulse: false,
      };
    case "info":
      return {
        bg: "bg-sky-400/10",
        text: "text-sky-300",
        dot: "bg-sky-400",
        pulse: false,
      };
    case "success":
      return {
        bg: "bg-success/10",
        text: "text-success",
        dot: "bg-success",
        pulse: false,
      };
    case "error":
      return {
        bg: "bg-error/10",
        text: "text-error",
        dot: "bg-error",
        pulse: false,
      };
    case "muted":
      return {
        bg: "bg-bg-tertiary",
        text: "text-text-muted",
        dot: "bg-text-muted",
        pulse: chip.status === "stopping",
      };
    default:
      return {
        bg: "bg-bg-tertiary",
        text: "text-text-secondary",
        dot: "bg-text-muted",
        pulse: false,
      };
  }
}

/**
 * Compute Run/Stop control state purely from `run_controls`.
 *
 * `hasWorkflow` lets callers opt out of showing controls at all for tasks
 * without an assigned workflow (the server still emits `run_controls` for
 * those, with `runnable=false`).
 */
export function deriveRunControlsState(
  controls: TaskRunControls | null | undefined,
  options: { hasWorkflow?: boolean } = {}
): RunControlsState {
  const hasWorkflow = options.hasWorkflow ?? true;
  const activeRun = controls?.active_run ?? null;
  const runStatus = activeRun?.status ?? null;
  const hasActiveRun = isActiveRunStatus(runStatus);
  const runnable = controls?.runnable === true;
  const stoppable = controls?.stoppable === true;
  const isStopping = runStatus === "stopping";

  // Surface should expose Stop while there is something to stop, OR while we
  // are mid-stop so the user can see the pending state. The disabled flag
  // below makes sure they cannot click Stop again during `stopping`.
  const showStop = hasWorkflow && (stoppable || isStopping || hasActiveRun);
  const runDisabled = !hasWorkflow || hasActiveRun || !runnable;
  const stopDisabled = !stoppable || isStopping;

  return {
    activeRun,
    hasActiveRun,
    runnable,
    stoppable,
    isStopping,
    showStop,
    runDisabled,
    stopDisabled,
  };
}
