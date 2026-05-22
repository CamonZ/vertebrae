import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Task, TaskRun, TaskRunStatus } from "../../bindings";
import type { ResolvedRunSource } from "../../hooks/useTaskRuns";
import { isActiveRunStatus } from "../../utils/runState";
import { IdentityBadge, ScanIdentifier } from "../shared/EntityId";
import {
  projectTaskRunTrace,
  type TaskRunTraceProjection,
} from "./taskRunTrace";
import { safeMs } from "./timeUtils";

const RAIL_STORAGE_KEY = "vertebrae.traces.runHistoryRail.width";
const DEFAULT_RAIL_WIDTH = 288;
const MIN_RAIL_WIDTH = 220;
const MAX_RAIL_WIDTH = 560;
const ROW_BASE_PADDING_PX = 6;
const ROW_DEPTH_INDENT_PX = 10;

interface RunHistoryRailProps {
  /** All known runs for the current trace tree. */
  runs: readonly TaskRun[];
  /** Tasks in the current trace tree, used to group attempts by task first. */
  tasks?: readonly Task[];
  runProjection?: TaskRunTraceProjection | null;
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
  direction: "right" | "left" | "down";
  className?: string;
}): ReactNode {
  const path =
    direction === "right"
      ? "M9 5l7 7-7 7"
      : direction === "left"
        ? "M15 19l-7-7 7-7"
        : "M19 9l-7 7-7-7";

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
        d={path}
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

interface TaskGroupRowProps {
  task: Task | null;
  taskId: string;
  depth: number;
  attemptCount: number;
  childCount: number;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
}

function TaskGroupRow({
  task,
  taskId,
  depth,
  attemptCount,
  childCount,
  isCollapsed,
  onToggleCollapsed,
}: TaskGroupRowProps): ReactNode {
  const title = task?.title ?? taskId;
  const count = attemptCount > 0 ? attemptCount : childCount;
  const indentPx = depth * ROW_DEPTH_INDENT_PX;

  return (
    <li
      data-testid="run-history-task-group"
      data-task-id={taskId}
      data-depth={depth}
      data-attempt-count={attemptCount}
      data-child-count={childCount}
    >
      <div
        role="treeitem"
        aria-expanded={!isCollapsed}
        tabIndex={0}
        onClick={onToggleCollapsed}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggleCollapsed();
          }
        }}
        className="group relative flex h-9 cursor-pointer items-center gap-2 border-b border-border/40 pr-4 text-sm transition-colors hover:bg-bg-hover/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary"
        style={{ paddingLeft: `${ROW_BASE_PADDING_PX}px` }}
      >
        <div className="flex w-8 shrink-0 items-center justify-end gap-0.5">
          <span className="w-4 text-right font-mono text-[10px] tabular-nums text-text-muted">
            {count > 0 ? count : ""}
          </span>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggleCollapsed();
            }}
            aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${title}`}
            aria-expanded={!isCollapsed}
            data-testid="run-history-task-group-toggle"
            className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          >
            <Chevron
              direction={isCollapsed ? "right" : "down"}
              className="h-3 w-3"
            />
          </button>
        </div>
        {depth > 0 && (
          <span
            aria-hidden="true"
            className="shrink-0"
            style={{ width: `${indentPx}px` }}
          />
        )}
        <IdentityBadge
          id={taskId}
          kind="task"
          level={task?.level ?? null}
          testId="run-history-task-group-id"
          className="shrink-0"
        />
        <span className="min-w-0 flex-1 truncate font-medium text-text-primary">
          {title}
        </span>
      </div>
    </li>
  );
}

interface RunTreeRow {
  kind: "run";
  run: TaskRun;
  depth: number;
}

interface TaskTreeRow {
  kind: "task";
  task: Task | null;
  taskId: string;
  depth: number;
  attemptCount: number;
  childCount: number;
}

type RailRow = TaskTreeRow | RunTreeRow;

function compareRunsDescending(a: TaskRun, b: TaskRun): number {
  const diff =
    (safeMs(b.started_at) ?? safeMs(b.inserted_at) ?? 0) -
    (safeMs(a.started_at) ?? safeMs(a.inserted_at) ?? 0);
  if (diff !== 0) return diff;
  return a.id.localeCompare(b.id);
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

  roots.sort(compareRunsDescending);
  for (const children of childrenByParent.values()) {
    children.sort(compareRunsDescending);
  }

  const rows: RunTreeRow[] = [];
  const visited = new Set<string>();
  const visit = (run: TaskRun, depth: number): void => {
    if (visited.has(run.id)) return;
    visited.add(run.id);
    rows.push({ kind: "run", run, depth });
    for (const child of childrenByParent.get(run.id) ?? []) {
      visit(child, depth + 1);
    }
  };
  for (const root of roots) visit(root, 0);
  for (const run of byId.values()) visit(run, 0);
  return rows;
}

function rowsFromProjection(projection: TaskRunTraceProjection): RailRow[] {
  const rows: RailRow[] = [];
  for (const group of projection.orderedTaskGroups) {
    rows.push({
      kind: "task",
      task: group.task,
      taskId: group.taskId,
      depth: group.depth,
      attemptCount: group.runs.length,
      childCount: group.childTaskIds.length,
    });
    for (const node of [...group.runs].reverse()) {
      rows.push({
        kind: "run",
        run: node.run,
        depth: group.depth + 1,
      });
    }
  }
  return rows;
}

export function RunHistoryRail({
  runs,
  tasks = [],
  runProjection,
  activeRunId,
  activeRunSource,
  onSelectRun,
  onSwitchTask,
  collapsed,
  onToggleCollapsed,
}: RunHistoryRailProps): ReactNode {
  const railRef = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_RAIL_WIDTH;
    const stored = window.localStorage.getItem(RAIL_STORAGE_KEY);
    const parsed = stored ? Number.parseInt(stored, 10) : NaN;
    if (
      Number.isFinite(parsed) &&
      parsed >= MIN_RAIL_WIDTH &&
      parsed <= MAX_RAIL_WIDTH
    ) {
      return parsed;
    }
    return DEFAULT_RAIL_WIDTH;
  });
  const [isResizing, setIsResizing] = useState(false);
  const [collapsedTaskIds, setCollapsedTaskIds] = useState<Set<string>>(
    () => new Set()
  );

  const rows = useMemo(() => {
    if (runProjection?.hasRuns) return rowsFromProjection(runProjection);
    const projection = projectTaskRunTrace(runs, [], tasks);
    if (projection.hasRuns) return rowsFromProjection(projection);
    return orderRunsByLineage(runs);
  }, [runProjection, runs, tasks]);

  const toggleTaskGroup = useCallback((taskId: string) => {
    setCollapsedTaskIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const visibleRows = useMemo(() => {
    const visible: RailRow[] = [];
    let collapsedDepth: number | null = null;

    for (const row of rows) {
      if (collapsedDepth !== null) {
        if (row.depth > collapsedDepth) continue;
        collapsedDepth = null;
      }

      visible.push(row);
      if (row.kind === "task" && collapsedTaskIds.has(row.taskId)) {
        collapsedDepth = row.depth;
      }
    }

    return visible;
  }, [collapsedTaskIds, rows]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(RAIL_STORAGE_KEY, String(width));
    }
  }, [width]);

  const clampWidth = useCallback(
    (nextWidth: number) =>
      Math.max(MIN_RAIL_WIDTH, Math.min(MAX_RAIL_WIDTH, nextWidth)),
    []
  );

  const handleResizeMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsResizing(true);
    },
    []
  );

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (event: MouseEvent): void => {
      const left = railRef.current?.getBoundingClientRect().left ?? 0;
      setWidth(clampWidth(event.clientX - left));
    };
    const handleMouseUp = (): void => {
      setIsResizing(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [clampWidth, isResizing]);

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
      ref={railRef}
      data-testid="run-history-rail"
      data-collapsed="false"
      className="relative flex h-full flex-col border-r border-border bg-bg-secondary"
      style={{ width }}
    >
      <div
        role="separator"
        aria-label="Resize trace exploration panel"
        aria-orientation="vertical"
        aria-valuemin={MIN_RAIL_WIDTH}
        aria-valuemax={MAX_RAIL_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        data-testid="run-history-rail-resize-handle"
        onMouseDown={handleResizeMouseDown}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            setWidth((current) => clampWidth(current - 16));
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            setWidth((current) => clampWidth(current + 16));
          }
        }}
        className={`group absolute bottom-0 right-[-4px] top-0 z-10 w-2 cursor-ew-resize ${
          isResizing ? "bg-primary/15" : ""
        }`}
      >
        <div
          className={`absolute bottom-0 left-1 top-0 w-0.5 transition-colors ${
            isResizing ? "bg-primary" : "bg-transparent group-hover:bg-primary/50"
          }`}
        />
      </div>
      <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
        <span
          data-testid="run-history-rail-title"
          className="font-mono text-[10px] uppercase tracking-wider text-text-muted"
        >
          Tasks
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
            {visibleRows.map((row) =>
              row.kind === "task" ? (
                <TaskGroupRow
                  key={`task-${row.taskId}`}
                  task={row.task}
                  taskId={row.taskId}
                  depth={row.depth}
                  attemptCount={row.attemptCount}
                  childCount={row.childCount}
                  isCollapsed={collapsedTaskIds.has(row.taskId)}
                  onToggleCollapsed={() => toggleTaskGroup(row.taskId)}
                />
              ) : (
                <RunRow
                  key={row.run.id}
                  run={row.run}
                  isActive={row.run.id === activeRunId}
                  activeRunSource={activeRunSource}
                  depth={row.depth}
                  onSelect={() => onSelectRun(row.run.id)}
                />
              )
            )}
          </ul>
        )}
      </div>
    </aside>
  );
}
