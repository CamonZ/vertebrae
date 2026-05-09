import type { ReactNode } from "react";
import type { TaskRun, TaskRunStatus } from "../../bindings";
import type { ResolvedRunSource } from "../../hooks/useTaskRuns";
import { isActiveRunStatus } from "../../utils/runState";

interface RunHistoryRailProps {
  /** All known runs for the task, newest first. */
  runs: readonly TaskRun[];
  /**
   * The run that the trace view is currently showing. May come from an
   * explicit selection, the active run, or the latest terminal run.
   */
  activeRunId: string | null;
  /**
   * How `activeRunId` was selected, used to label the highlighted row.
   */
  activeRunSource: ResolvedRunSource;
  /** Called when the user picks a run from the list. */
  onSelectRun: (runId: string) => void;
  /** Switch to the task picker without losing the rail. */
  onSwitchTask?: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

function statusClasses(status: TaskRunStatus): string {
  switch (status) {
    case "executing":
    case "queued":
    case "waiting":
      return "bg-warning";
    case "completed":
      return "bg-success";
    case "failed":
      return "bg-error";
    case "stopping":
    case "stopped":
      return "bg-text-muted";
    default:
      return "bg-text-muted";
  }
}

function Chevron({
  direction,
  className,
}: {
  direction: "right" | "left";
  className?: string;
}): ReactNode {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d={direction === "right" ? "M9 5l7 7-7 7" : "M15 19l-7-7 7-7"}
      />
    </svg>
  );
}

/** Format an ISO timestamp as a short HH:MM marker for compact rail display. */
function formatStartedAt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

interface RunRowProps {
  run: TaskRun;
  isActive: boolean;
  activeRunSource: ResolvedRunSource;
  onSelect: () => void;
}

function RunRow({
  run,
  isActive,
  activeRunSource,
  onSelect,
}: RunRowProps): ReactNode {
  const terminal = !isActiveRunStatus(run.status);
  const label = run.status.replace(/_/g, " ");
  return (
    <li
      data-testid="run-history-row"
      data-run-id={run.id}
      data-status={run.status}
      data-terminal={terminal ? "true" : "false"}
      data-active={isActive ? "true" : "false"}
      data-active-source={isActive ? activeRunSource : undefined}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={isActive ? "true" : undefined}
        data-testid="run-history-row-button"
        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-bg-hover ${
          isActive ? "bg-bg-hover" : ""
        }`}
      >
        <span
          data-testid="run-history-row-pip"
          data-status={run.status}
          title={label}
          className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${statusClasses(
            run.status
          )}`}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2 truncate font-mono text-[11px] text-text-primary">
            <span className="truncate">{label}</span>
            {isActive && activeRunSource !== "selected" && (
              <span
                data-testid="run-history-row-source"
                className="rounded bg-bg-tertiary px-1 font-mono text-[9px] uppercase tracking-wider text-text-muted"
              >
                {activeRunSource}
              </span>
            )}
          </span>
          <span className="truncate font-mono text-[10px] text-text-muted">
            {formatStartedAt(run.started_at)} · {run.id.slice(0, 8)}
          </span>
        </span>
      </button>
    </li>
  );
}

export function RunHistoryRail({
  runs,
  activeRunId,
  activeRunSource,
  onSelectRun,
  onSwitchTask,
  collapsed,
  onToggleCollapsed,
}: RunHistoryRailProps): ReactNode {
  if (collapsed) {
    return (
      <aside
        data-testid="run-history-rail"
        data-collapsed="true"
        className="flex h-full w-8 flex-col items-center border-r border-border bg-bg-secondary py-2"
      >
        {onToggleCollapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            data-testid="run-history-rail-toggle"
            aria-label="Expand run history rail"
            className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text-secondary"
          >
            <Chevron direction="right" className="h-4 w-4" />
          </button>
        )}
      </aside>
    );
  }

  return (
    <aside
      data-testid="run-history-rail"
      data-collapsed="false"
      className="flex h-full w-72 flex-col border-r border-border bg-bg-secondary"
    >
      <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
        <span
          data-testid="run-history-rail-title"
          className="font-mono text-[10px] uppercase tracking-wider text-text-muted"
        >
          Runs
        </span>
        <div className="flex items-center gap-1">
          {onSwitchTask && (
            <button
              type="button"
              onClick={onSwitchTask}
              data-testid="run-history-rail-switch-task"
              aria-label="Switch task"
              className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-text-muted hover:bg-bg-hover hover:text-text-secondary"
            >
              Switch
            </button>
          )}
          {onToggleCollapsed && (
            <button
              type="button"
              onClick={onToggleCollapsed}
              data-testid="run-history-rail-toggle"
              aria-label="Collapse run history rail"
              className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text-secondary"
            >
              <Chevron direction="left" className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {runs.length === 0 ? (
          <div
            data-testid="run-history-rail-empty"
            className="px-3 py-6 text-center text-xs italic text-text-muted"
          >
            No runs for this task yet.
          </div>
        ) : (
          <ul data-testid="run-history-rail-list" className="divide-y divide-border">
            {runs.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                isActive={run.id === activeRunId}
                activeRunSource={activeRunSource}
                onSelect={() => onSelectRun(run.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
