import type { Task, TaskRun, TaskRunControls, TaskRunStatus } from "../bindings";

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
export function isActiveRunStatus(status: TaskRunStatus | null | undefined): boolean {
  return status != null && ACTIVE_RUN_STATUSES.has(status);
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
  tone:
    | "neutral"
    | "info"
    | "warning"
    | "success"
    | "error"
    | "muted";
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
  switch (status) {
    case "queued":
      return { label, status, isActive: true, tone: "info" };
    case "executing":
      return { label, status, isActive: true, tone: "warning" };
    case "waiting":
      return { label, status, isActive: true, tone: "info" };
    case "stopping":
      return { label, status, isActive: true, tone: "muted" };
    case "stopped":
      return { label, status, isActive: false, tone: "muted" };
    case "completed":
      return { label, status, isActive: false, tone: "success" };
    case "failed":
      return { label, status, isActive: false, tone: "error" };
    default:
      return { label, status, isActive: false, tone: "neutral" };
  }
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

export function runStatusLabel(status: TaskRunStatus | null | undefined): string {
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
      return { bg: "bg-warning/10", text: "text-warning", dot: "bg-warning", pulse: true };
    case "info":
      return { bg: "bg-info/10", text: "text-info", dot: "bg-info", pulse: chip.status === "queued" };
    case "success":
      return { bg: "bg-success/10", text: "text-success", dot: "bg-success", pulse: false };
    case "error":
      return { bg: "bg-error/10", text: "text-error", dot: "bg-error", pulse: false };
    case "muted":
      return { bg: "bg-bg-tertiary", text: "text-text-muted", dot: "bg-text-muted", pulse: chip.status === "stopping" };
    default:
      return { bg: "bg-bg-tertiary", text: "text-text-secondary", dot: "bg-text-muted", pulse: false };
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
