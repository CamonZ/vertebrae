import { useMemo, useState, type ReactNode } from "react";
import type {
  ExecutionStatus,
  SessionLog,
  StepExecution,
  Task,
} from "../../bindings";
import { useScopedSessionLogs } from "../../hooks/useScopedSessionLogs";
import {
  computeExecutionRollups,
  costFromSessionLogs,
  formatCost,
  parseCost,
  type ExecutionRollups,
} from "../../utils";

interface SubtreeRailProps {
  rootTaskId: string;
  tasks: readonly Task[];
  subtreeTaskIds: readonly string[];
  executions: readonly StepExecution[];
  /**
   * Per-execution session logs. When an execution lacks a populated
   * `cost` field, the per-task and per-execution rollups fall back to
   * summing `cost_usd` from `session_end` log entries. Defaults to the
   * global live `sessionLogStore` map when omitted.
   */
  logsByExecutionId?: Readonly<Record<string, SessionLog[]>>;
  fallbackCostByExecutionId?: Readonly<Record<string, number>>;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onSwitchTask?: () => void;
}

const EMPTY_LOGS_BY_EXECUTION_ID: Readonly<Record<string, SessionLog[]>> = {};
const EMPTY_COSTS_BY_EXECUTION_ID: Readonly<Record<string, number>> = {};

interface GroupRow {
  task: Task;
  depth: number;
  executions: StepExecution[];
  rollups: ExecutionRollups;
}

function statusClasses(status: ExecutionStatus): string {
  switch (status) {
    case "in_progress":
      return "bg-[var(--color-warn)]";
    case "completed":
      return "bg-[var(--color-ok)]";
    case "failed":
      return "bg-[var(--color-err)]";
    default:
      return "bg-fg-mute";
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

function computeDepths(
  rootTaskId: string,
  tasks: readonly Task[],
  subtreeTaskIds: readonly string[]
): Map<string, number> {
  const taskById = new Map<string, Task>();
  for (const t of tasks) taskById.set(t.id, t);

  const depths = new Map<string, number>();
  depths.set(rootTaskId, 0);

  const ids = new Set(subtreeTaskIds);

  function depthOf(id: string, seen: Set<string>): number {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0; // cycle guard
    seen.add(id);
    const task = taskById.get(id);
    if (!task || !task.parent_id || !ids.has(task.parent_id)) {
      depths.set(id, 0);
      return 0;
    }
    const d = depthOf(task.parent_id, seen) + 1;
    depths.set(id, d);
    return d;
  }

  for (const id of subtreeTaskIds) depthOf(id, new Set());
  return depths;
}

function StatusPip({ status }: { status: ExecutionStatus }): ReactNode {
  return (
    <span
      data-testid="subtree-rail-pip"
      data-status={status}
      title={status.replace(/_/g, " ")}
      className={`inline-block h-1.5 w-1.5 rounded-full ${statusClasses(status)}`}
    />
  );
}

function ExecutionRow({
  execution,
  logs,
  fallbackCost,
}: {
  execution: StepExecution;
  logs: SessionLog[] | undefined;
  fallbackCost: number | undefined;
}): ReactNode {
  let displayCost: number | null = parseCost(execution.cost);
  if (displayCost === null) {
    const fromLogs = fallbackCost ?? costFromSessionLogs(logs);
    if (fromLogs > 0) displayCost = fromLogs;
  }
  return (
    <li
      data-testid="subtree-rail-execution"
      data-execution-id={execution.id ?? ""}
      data-status={execution.status ?? "in_progress"}
      className="flex items-center gap-2 px-2 py-1 text-eyebrow text-[var(--color-fg-soft)]"
    >
      <StatusPip status={execution.status ?? "in_progress"} />
      <span className="truncate font-mono">
        {(execution.step_name ?? "").replace(/_/g, " ") || "step"}
      </span>
      {displayCost !== null && (
        <span className="ml-auto font-mono text-2xs text-[var(--color-fg-mute)]">
          {formatCost(displayCost)}
        </span>
      )}
    </li>
  );
}

interface GroupSectionProps {
  row: GroupRow;
  initiallyExpanded: boolean;
  logsByExecutionId: Readonly<Record<string, SessionLog[]>>;
  fallbackCostByExecutionId: Readonly<Record<string, number>>;
}

function GroupSection({
  row,
  initiallyExpanded,
  logsByExecutionId,
  fallbackCostByExecutionId,
}: GroupSectionProps): ReactNode {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const { task, depth, executions, rollups } = row;

  const statusCounts = useMemo(() => {
    const counts: Record<ExecutionStatus, number> = {
      in_progress: 0,
      completed: 0,
      failed: 0,
    };
    for (const e of executions) {
      const s = e.status ?? "in_progress";
      counts[s] += 1;
    }
    return counts;
  }, [executions]);

  return (
    <section
      data-testid="subtree-rail-group"
      data-task-id={task.id}
      data-depth={depth}
      data-expanded={expanded}
      className="border-b border-[var(--color-line)] last:border-b-0"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        data-testid="subtree-rail-group-toggle"
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-[var(--color-bg-3)]"
        style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
      >
        <Chevron
          direction="right"
          className={`h-3 w-3 flex-shrink-0 text-[var(--color-fg-mute)] transition-transform ${
            expanded ? "rotate-90" : ""
          }`}
        />
        <span className="truncate text-xs font-medium text-[var(--color-fg)]">
          {task.title}
        </span>
        <span
          data-testid="subtree-rail-group-pips"
          className="ml-auto flex items-center gap-0.5"
        >
          {(["failed", "in_progress", "completed"] as const).map((status) => {
            const count = statusCounts[status];
            if (count === 0) return null;
            const label = status.replace(/_/g, " ");
            return (
              <span
                key={status}
                data-status={status}
                data-count={count}
                title={`${count} ${label}`}
                className={`inline-block h-1.5 w-1.5 rounded-full ${statusClasses(status)}`}
              />
            );
          })}
        </span>
      </button>

      <div
        data-testid="subtree-rail-group-rollup"
        className="flex items-center gap-2 px-2 pb-1 font-mono text-2xs text-[var(--color-fg-mute)]"
        style={{ paddingLeft: `${1.75 + depth * 0.75}rem` }}
      >
        <span data-testid="subtree-rail-group-runs">
          {rollups.totalRuns} {rollups.totalRuns === 1 ? "run" : "runs"}
        </span>
        <span aria-hidden="true">·</span>
        <span data-testid="subtree-rail-group-attempts">
          {rollups.totalAttempts}{" "}
          {rollups.totalAttempts === 1 ? "attempt" : "attempts"}
        </span>
        <span aria-hidden="true">·</span>
        <span data-testid="subtree-rail-group-cost">
          {formatCost(rollups.totalCost)}
        </span>
      </div>

      {expanded && (
        <ul
          data-testid="subtree-rail-group-executions"
          className="pb-1"
          style={{ paddingLeft: `${1.5 + depth * 0.75}rem` }}
        >
          {executions.length === 0 ? (
            <li className="px-2 py-1 text-eyebrow italic text-[var(--color-fg-mute)]">
              No executions yet
            </li>
          ) : (
            executions.map((exec, idx) => (
              <ExecutionRow
                key={exec.id ?? `${task.id}-${idx}`}
                execution={exec}
                logs={exec.id ? logsByExecutionId[exec.id] : undefined}
                fallbackCost={
                  exec.id ? fallbackCostByExecutionId[exec.id] : undefined
                }
              />
            ))
          )}
        </ul>
      )}
    </section>
  );
}

function SubtreeRailContent({
  rootTaskId,
  tasks,
  subtreeTaskIds,
  executions,
  logsByExecutionId: providedLogs,
  fallbackCostByExecutionId: providedFallbackCosts,
  collapsed,
  onToggleCollapsed,
  onSwitchTask,
}: SubtreeRailProps): ReactNode {
  const logsByExecutionId = providedLogs ?? EMPTY_LOGS_BY_EXECUTION_ID;
  const fallbackCostByExecutionId =
    providedFallbackCosts ?? EMPTY_COSTS_BY_EXECUTION_ID;
  const rows = useMemo<GroupRow[]>(() => {
    const taskById = new Map<string, Task>();
    for (const t of tasks) taskById.set(t.id, t);

    const depths = computeDepths(rootTaskId, tasks, subtreeTaskIds);

    const execsByTask = new Map<string, StepExecution[]>();
    for (const exec of executions) {
      const tid = exec.task_id;
      if (!tid) continue;
      const list = execsByTask.get(tid);
      if (list) {
        list.push(exec);
      } else {
        execsByTask.set(tid, [exec]);
      }
    }

    const built: GroupRow[] = [];
    for (const id of subtreeTaskIds) {
      const task = taskById.get(id);
      if (!task) continue;
      const taskExecs = execsByTask.get(id) ?? [];
      built.push({
        task,
        depth: depths.get(id) ?? 0,
        executions: taskExecs,
        rollups: computeExecutionRollups(
          taskExecs,
          logsByExecutionId,
          fallbackCostByExecutionId
        ),
      });
    }

    built.sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      return a.task.title.localeCompare(b.task.title);
    });

    return built;
  }, [
    rootTaskId,
    tasks,
    subtreeTaskIds,
    executions,
    fallbackCostByExecutionId,
    logsByExecutionId,
  ]);

  if (collapsed) {
    return (
      <aside
        data-testid="subtree-rail"
        data-collapsed="true"
        className="flex h-full w-8 flex-col items-center border-r border-[var(--color-line)] bg-[var(--color-bg-1)] py-2"
      >
        {onToggleCollapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            data-testid="subtree-rail-toggle"
            aria-label="Expand subtree rail"
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
      data-testid="subtree-rail"
      data-collapsed="false"
      className="flex h-full w-72 flex-col border-r border-[var(--color-line)] bg-[var(--color-bg-1)]"
    >
      <div className="flex items-center justify-between border-b border-[var(--color-line)] px-2 py-1.5">
        <span className="font-mono text-2xs uppercase tracking-wider text-[var(--color-fg-mute)]">
          Subtree
        </span>
        <div className="flex items-center gap-1">
          {onSwitchTask && (
            <button
              type="button"
              onClick={onSwitchTask}
              data-testid="subtree-rail-switch-task"
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
              data-testid="subtree-rail-toggle"
              aria-label="Collapse subtree rail"
              className="rounded p-1 text-[var(--color-fg-mute)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg-soft)]"
            >
              <Chevron direction="left" className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <div
            data-testid="subtree-rail-empty"
            className="px-3 py-6 text-center text-xs italic text-[var(--color-fg-mute)]"
          >
            No tasks in this subtree.
          </div>
        ) : (
          rows.map((row) => (
            <GroupSection
              key={row.task.id}
              row={row}
              initiallyExpanded={row.depth === 0}
              logsByExecutionId={logsByExecutionId}
              fallbackCostByExecutionId={fallbackCostByExecutionId}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function LiveSubtreeRail(props: SubtreeRailProps): ReactNode {
  const executionIds = useMemo(
    () => props.executions.map((execution) => execution.id),
    [props.executions]
  );
  const liveBuckets = useScopedSessionLogs(executionIds);
  const logsByExecutionId = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(liveBuckets).map(([id, bucket]) => [id, bucket.logs])
      ),
    [liveBuckets]
  );
  const fallbackCostByExecutionId = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(liveBuckets).map(([id, bucket]) => [
          id,
          bucket.fallbackCost,
        ])
      ),
    [liveBuckets]
  );

  return (
    <SubtreeRailContent
      {...props}
      logsByExecutionId={logsByExecutionId}
      fallbackCostByExecutionId={fallbackCostByExecutionId}
    />
  );
}

export function SubtreeRail(props: SubtreeRailProps): ReactNode {
  if (
    props.logsByExecutionId !== undefined ||
    props.fallbackCostByExecutionId !== undefined
  ) {
    return <SubtreeRailContent {...props} />;
  }
  return <LiveSubtreeRail {...props} />;
}
