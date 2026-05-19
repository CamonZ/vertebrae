import type { ReactNode } from "react";
import type { TaskRun, TaskRunStatus } from "../../bindings";
import type { ResolvedRunSource } from "../../hooks/useTaskRuns";
import { isActiveRunStatus } from "../../utils/runState";
import { ScanIdentifier } from "../shared/EntityId";

interface RunHistoryRailProps {
  /** All known runs for the current trace tree. */
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
  depth: number;
  onSelect: () => void;
}

function RunRow({
  run,
  isActive,
  activeRunSource,
  depth,
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
      data-depth={depth}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={isActive ? "true" : undefined}
        data-testid="run-history-row-button"
        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-bg-hover ${
          isActive ? "bg-bg-hover" : ""
        }`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
      >
        {depth > 0 && (
          <span
            aria-hidden="true"
            className="-ml-1 h-px w-3 flex-shrink-0 bg-border"
          />
        )}
        <span
          data-testid="run-history-row-pip"
          data-status={run.status}
          title={label}
          className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${statusClasses(
            run.status
          )}`}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2 truncate font-mono text-xs text-text-primary">
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
          <span className="flex items-center gap-1 truncate font-mono text-[10px] text-text-muted">
            <span>{formatStartedAt(run.started_at)} ·</span>
            <ScanIdentifier
              id={run.id}
              kind="task run"
              className="text-[10px]"
              testId="run-history-row-id"
            />
          </span>
        </span>
      </button>
    </li>
  );
}

interface RunTreeRow {
  run: TaskRun;
  depth: number;
}

function orderRunsByLineage(runs: readonly TaskRun[]): RunTreeRow[] {
  const byId = new Map<string, TaskRun>();
  for (const run of runs) {
    if (!byId.has(run.id)) byId.set(run.id, run);
  }

  const childrenByParent = new Map<string, TaskRun[]>();
  const roots: TaskRun[] = [];

  for (const run of byId.values()) {
    const parentId = run.parent_task_run_id;
    if (parentId && byId.has(parentId)) {
      const children = childrenByParent.get(parentId);
      if (children) children.push(run);
      else childrenByParent.set(parentId, [run]);
    } else {
      roots.push(run);
    }
  }

  const timestamp = (run: TaskRun): number => {
    const value = Date.parse(run.started_at ?? run.inserted_at ?? "");
    return Number.isNaN(value) ? 0 : value;
  };
  const byStartedDesc = (a: TaskRun, b: TaskRun): number =>
    timestamp(b) - timestamp(a);

  roots.sort(byStartedDesc);
  for (const children of childrenByParent.values()) {
    children.sort(byStartedDesc);
  }

  const rows: RunTreeRow[] = [];
  const visited = new Set<string>();
  const visit = (run: TaskRun, depth: number): void => {
    if (visited.has(run.id)) return;
    visited.add(run.id);
    rows.push({ run, depth });
    for (const child of childrenByParent.get(run.id) ?? []) {
      visit(child, depth + 1);
    }
  };
  for (const root of roots) visit(root, 0);
  for (const run of byId.values()) visit(run, 0);
  return rows;
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
  const rows = orderRunsByLineage(runs);

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
          <ul
            data-testid="run-history-rail-list"
            className="divide-y divide-border"
          >
            {rows.map(({ run, depth }) => (
              <RunRow
                key={run.id}
                run={run}
                isActive={run.id === activeRunId}
                activeRunSource={activeRunSource}
                depth={depth}
                onSelect={() => onSelectRun(run.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
