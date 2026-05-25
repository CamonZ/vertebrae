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
import { safeMs } from "./timeUtils";

const RAIL_STORAGE_KEY = "vertebrae.traces.runHistoryRail.width";
const TASKS_HEIGHT_STORAGE_KEY = "vertebrae.traces.runHistoryRail.tasksHeight";
const DEFAULT_RAIL_WIDTH = 288;
const MIN_RAIL_WIDTH = 220;
const MAX_RAIL_WIDTH = 560;
const DEFAULT_TASKS_HEIGHT = 220;
const MIN_TASKS_HEIGHT = 80;
const MAX_TASKS_HEIGHT = 600;

interface RunHistoryRailProps {
  /**
   * Tasks in the current trace tree (ancestors + self + descendants).
   * Used to render the top TASKS tree.
   */
  tasks: readonly Task[];
  /** All known runs across every task in the trace tree. */
  runs: readonly TaskRun[];
  /** The page's currently routed task. Highlighted in TASKS, scopes RUNS. */
  currentTaskId: string | null;
  /**
   * The run that the trace view is currently showing. May come from an
   * explicit selection, the active run, or the latest terminal run.
   */
  activeRunId: string | null;
  /**
   * How `activeRunId` was selected, used to label the highlighted row.
   */
  activeRunSource: ResolvedRunSource;
  /** Select a task: navigates the page and refills RUNS with its runs. */
  onSelectTask: (taskId: string) => void;
  /** Select a run from the RUNS panel (scopes the trace to it). */
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
      return "bg-[var(--color-warn)]";
    case "completed":
      return "bg-[var(--color-ok)]";
    case "failed":
      return "bg-[var(--color-err)]";
    case "stopping":
    case "stopped":
      return "bg-text-muted";
    default:
      return "bg-text-muted";
  }
}

function statusGlyph(status: TaskRunStatus): string {
  switch (status) {
    case "executing":
      return "↻";
    case "queued":
    case "waiting":
      return "…";
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "stopping":
    case "stopped":
      return "■";
    default:
      return "•";
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

function formatStartedAt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

interface TaskTreeRow {
  task: Task | null;
  taskId: string;
  depth: number;
}

function compareTasks(a: Task, b: Task): number {
  const aTs = a.created_at ?? "";
  const bTs = b.created_at ?? "";
  if (aTs !== bTs) return aTs.localeCompare(bTs);
  return a.id.localeCompare(b.id);
}

function buildTaskTree(tasks: readonly Task[]): TaskTreeRow[] {
  if (tasks.length === 0) return [];
  const byId = new Map<string, Task>();
  for (const t of tasks) byId.set(t.id, t);

  const childrenByParent = new Map<string | null, Task[]>();
  for (const t of tasks) {
    const parentId =
      t.parent_id && byId.has(t.parent_id) ? t.parent_id : null;
    const bucket = childrenByParent.get(parentId);
    if (bucket) bucket.push(t);
    else childrenByParent.set(parentId, [t]);
  }
  for (const bucket of childrenByParent.values()) bucket.sort(compareTasks);

  const rows: TaskTreeRow[] = [];
  const visited = new Set<string>();
  const visit = (task: Task, depth: number): void => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    rows.push({ task, taskId: task.id, depth });
    for (const child of childrenByParent.get(task.id) ?? []) {
      visit(child, depth + 1);
    }
  };
  for (const root of childrenByParent.get(null) ?? []) visit(root, 0);
  // Surface any orphan tasks (e.g., partial fetch state) at depth 0.
  for (const t of tasks) if (!visited.has(t.id)) visit(t, 0);
  return rows;
}

function compareRunsDescending(a: TaskRun, b: TaskRun): number {
  const diff =
    (safeMs(b.started_at) ?? safeMs(b.inserted_at) ?? 0) -
    (safeMs(a.started_at) ?? safeMs(a.inserted_at) ?? 0);
  if (diff !== 0) return diff;
  return a.id.localeCompare(b.id);
}

interface TaskRowProps {
  row: TaskTreeRow;
  isCurrent: boolean;
  onSelect: () => void;
}

function TaskRow({ row, isCurrent, onSelect }: TaskRowProps): ReactNode {
  const { task, taskId, depth } = row;
  const title = task?.title ?? taskId;
  return (
    <li
      data-testid="run-history-task-row"
      data-task-id={taskId}
      data-depth={depth}
      data-active={isCurrent ? "true" : "false"}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={isCurrent ? "true" : undefined}
        data-testid="run-history-task-row-button"
        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-bg-3)] ${
          isCurrent
            ? "border-l-2 border-[var(--color-accent)] bg-[var(--color-bg-3)] text-[var(--color-fg)]"
            : "border-l-2 border-transparent text-[var(--color-fg-soft)]"
        }`}
        style={{ paddingLeft: `${10 + depth * 14}px` }}
      >
        {depth > 0 && (
          <span
            aria-hidden="true"
            className="font-mono text-[var(--color-fg-mute)]"
          >
            ↳
          </span>
        )}
        <IdentityBadge
          id={taskId}
          kind="task"
          level={task?.level ?? null}
          testId="run-history-task-row-id"
          className="shrink-0"
        />
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </button>
    </li>
  );
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
  const glyph = statusGlyph(run.status);
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
        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--color-bg-3)] ${
          isActive
            ? "border-l-2 border-[var(--color-accent)] bg-[var(--color-bg-3)]"
            : "border-l-2 border-transparent"
        }`}
      >
        <span
          data-testid="run-history-row-pip"
          data-status={run.status}
          title={label}
          className={`inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-2xs leading-none text-[var(--color-bg-0)] ${statusClasses(
            run.status
          )}`}
        >
          {glyph}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2 truncate font-mono text-eyebrow text-[var(--color-fg)]">
            <span className="truncate">{label}</span>
            {isActive && activeRunSource !== "selected" && (
              <span
                data-testid="run-history-row-source"
                className="rounded bg-[var(--color-bg-2)] px-1 font-mono text-[9px] uppercase tracking-wider text-[var(--color-fg-mute)]"
              >
                {activeRunSource}
              </span>
            )}
          </span>
          <span className="flex items-center gap-1 truncate font-mono text-2xs text-[var(--color-fg-mute)]">
            <span>{formatStartedAt(run.started_at)} ·</span>
            <ScanIdentifier
              id={run.id}
              kind="task run"
              className="text-2xs"
              testId="run-history-row-id"
            />
          </span>
        </span>
      </button>
    </li>
  );
}

export function RunHistoryRail({
  tasks,
  runs,
  currentTaskId,
  activeRunId,
  activeRunSource,
  onSelectTask,
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
  const [tasksHeight, setTasksHeight] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_TASKS_HEIGHT;
    const stored = window.localStorage.getItem(TASKS_HEIGHT_STORAGE_KEY);
    const parsed = stored ? Number.parseInt(stored, 10) : NaN;
    if (
      Number.isFinite(parsed) &&
      parsed >= MIN_TASKS_HEIGHT &&
      parsed <= MAX_TASKS_HEIGHT
    ) {
      return parsed;
    }
    return DEFAULT_TASKS_HEIGHT;
  });
  const [isResizingTasks, setIsResizingTasks] = useState(false);
  const tasksPanelRef = useRef<HTMLDivElement | null>(null);

  const taskRows = useMemo(() => buildTaskTree(tasks), [tasks]);

  const currentTaskRuns = useMemo(() => {
    if (!currentTaskId) return [];
    return runs
      .filter((r) => r.task_id === currentTaskId)
      .slice()
      .sort(compareRunsDescending);
  }, [runs, currentTaskId]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(RAIL_STORAGE_KEY, String(width));
    }
  }, [width]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        TASKS_HEIGHT_STORAGE_KEY,
        String(tasksHeight)
      );
    }
  }, [tasksHeight]);

  const clampWidth = useCallback(
    (nextWidth: number) =>
      Math.max(MIN_RAIL_WIDTH, Math.min(MAX_RAIL_WIDTH, nextWidth)),
    []
  );
  const clampTasksHeight = useCallback(
    (next: number) =>
      Math.max(MIN_TASKS_HEIGHT, Math.min(MAX_TASKS_HEIGHT, next)),
    []
  );

  const handleResizeMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsResizing(true);
    },
    []
  );
  const handleTasksResizeMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsResizingTasks(true);
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

  useEffect(() => {
    if (!isResizingTasks) return;

    const handleMouseMove = (event: MouseEvent): void => {
      const top = tasksPanelRef.current?.getBoundingClientRect().top ?? 0;
      setTasksHeight(clampTasksHeight(event.clientY - top));
    };
    const handleMouseUp = (): void => {
      setIsResizingTasks(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [clampTasksHeight, isResizingTasks]);

  if (collapsed) {
    return (
      <aside
        data-testid="run-history-rail"
        data-collapsed="true"
        className="flex h-full w-8 flex-col items-center border-r border-[var(--color-line)] bg-[var(--color-bg-1)] py-2"
      >
        {onToggleCollapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            data-testid="run-history-rail-toggle"
            aria-label="Expand run history rail"
            className="rounded p-1 text-[var(--color-fg-mute)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg-soft)]"
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
      className="relative flex h-full flex-col border-r border-[var(--color-line)] bg-[var(--color-bg-1)]"
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
          isResizing ? "bg-[var(--color-accent)]/15" : ""
        }`}
      >
        <div
          className={`absolute bottom-0 left-1 top-0 w-0.5 transition-colors ${
            isResizing
              ? "bg-[var(--color-accent)]"
              : "bg-transparent group-hover:bg-[var(--color-accent)]/50"
          }`}
        />
      </div>

      <section
        ref={tasksPanelRef}
        data-testid="run-history-tasks-section"
        className="flex min-h-0 flex-col"
        style={{ height: tasksHeight }}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-line)] px-2 py-1.5">
          <span
            data-testid="run-history-rail-title"
            className="font-mono text-2xs uppercase tracking-wider text-[var(--color-fg-mute)]"
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
                className="rounded px-1.5 py-0.5 text-2xs uppercase tracking-wider text-[var(--color-fg-mute)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg-soft)]"
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
                className="rounded p-1 text-[var(--color-fg-mute)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg-soft)]"
              >
                <Chevron direction="left" className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {taskRows.length === 0 ? (
            <div
              data-testid="run-history-tasks-empty"
              className="px-3 py-4 text-center text-xs italic text-[var(--color-fg-mute)]"
            >
              No tasks in this trace.
            </div>
          ) : (
            <ul data-testid="run-history-tasks-list">
              {taskRows.map((row) => (
                <TaskRow
                  key={row.taskId}
                  row={row}
                  isCurrent={row.taskId === currentTaskId}
                  onSelect={() => onSelectTask(row.taskId)}
                />
              ))}
            </ul>
          )}
        </div>
      </section>

      <div
        role="separator"
        aria-label="Resize tasks panel"
        aria-orientation="horizontal"
        aria-valuemin={MIN_TASKS_HEIGHT}
        aria-valuemax={MAX_TASKS_HEIGHT}
        aria-valuenow={tasksHeight}
        tabIndex={0}
        data-testid="run-history-tasks-resize-handle"
        onMouseDown={handleTasksResizeMouseDown}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setTasksHeight((current) => clampTasksHeight(current - 16));
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            setTasksHeight((current) => clampTasksHeight(current + 16));
          }
        }}
        className={`relative h-1 cursor-ns-resize border-b border-[var(--color-line)] ${
          isResizingTasks ? "bg-[var(--color-accent)]/40" : "hover:bg-[var(--color-accent)]/30"
        }`}
      />

      <section
        data-testid="run-history-runs-section"
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-line)] px-2 py-1.5">
          <span
            data-testid="run-history-runs-title"
            className="font-mono text-2xs uppercase tracking-wider text-[var(--color-fg-mute)]"
          >
            Runs
          </span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {!currentTaskId ? (
            <div
              data-testid="run-history-rail-empty"
              className="px-3 py-6 text-center text-xs italic text-[var(--color-fg-mute)]"
            >
              Select a task to see its runs.
            </div>
          ) : currentTaskRuns.length === 0 ? (
            <div
              data-testid="run-history-rail-empty"
              className="px-3 py-6 text-center text-xs italic text-[var(--color-fg-mute)]"
            >
              No runs for this task yet.
            </div>
          ) : (
            <ul
              data-testid="run-history-rail-list"
              className="divide-y divide-border"
            >
              {currentTaskRuns.map((run) => (
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
      </section>
    </aside>
  );
}
