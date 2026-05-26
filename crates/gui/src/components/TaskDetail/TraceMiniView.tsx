import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type { ExecutionStatus, StepExecution } from "../../bindings";
import { useTaskExecutions } from "../../hooks";
import { useSubtreeExecutions } from "../../hooks/useSubtreeExecutions";
import { useSessionLogStore } from "../../stores/sessionLogStore";
import { computeExecutionRollups, formatCost, parseCost, popOut } from "../../utils";
import { formatDuration } from "../Operations/formatDuration";
import { StatusBadge } from "../molecules/StatusBadge";

interface TraceMiniViewProps {
  taskId: string;
  workflowName?: string | null;
  stepName?: string | null;
}

function getStatusStyles(status: ExecutionStatus): {
  bg: string;
  text: string;
} {
  switch (status) {
    case "in_progress":
      return {
        bg: "bg-[var(--color-warn-wash)]",
        text: "text-[var(--color-warn)]",
      };
    case "completed":
      return {
        bg: "bg-[var(--color-ok-wash)]",
        text: "text-[var(--color-ok)]",
      };
    case "failed":
      return {
        bg: "bg-[var(--color-err-wash)]",
        text: "text-[var(--color-err)]",
      };
    default:
      return {
        bg: "bg-[var(--color-bg-2)]",
        text: "text-[var(--color-fg-mute)]",
      };
  }
}

function StatusPill({ status }: { status: ExecutionStatus }) {
  const styles = getStatusStyles(status);
  return (
    <span
      data-testid="trace-mini-status"
      data-status={status}
      className={`inline-flex flex-shrink-0 items-center rounded-full px-2 py-0.5 text-2xs font-medium uppercase tracking-wider ${styles.bg} ${styles.text}`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

function pickLastExecution(
  executions: readonly StepExecution[]
): StepExecution | null {
  if (executions.length === 0) return null;
  let latest: StepExecution | null = null;
  let latestMs = -Infinity;
  for (const exec of executions) {
    const ts = exec.started_at ? Date.parse(exec.started_at) : NaN;
    if (Number.isFinite(ts) && ts > latestMs) {
      latestMs = ts;
      latest = exec;
    }
  }
  return latest ?? executions[0];
}

interface RollupCardProps {
  label: string;
  runs: number;
  attempts: number;
  cost: number;
  testId: string;
  accent?: boolean;
}

function RollupCard({
  label,
  runs,
  attempts,
  cost,
  testId,
  accent,
}: RollupCardProps) {
  const containerClass = accent
    ? "rounded-[var(--radius-md)] border border-[color-mix(in_oklab,var(--color-accent)_30%,var(--color-line))] bg-[color-mix(in_oklab,var(--color-accent)_10%,var(--color-bg-3))] px-2 py-1.5"
    : "rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-bg-3)] px-2 py-1.5";
  const labelClass = accent
    ? "font-mono text-[9px] uppercase tracking-wider text-[var(--color-accent)]"
    : "font-mono text-[9px] uppercase tracking-wider text-[var(--color-fg-mute)]";
  return (
    <div data-testid={testId} className={containerClass}>
      <div className={labelClass}>{label}</div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span
          data-testid={`${testId}-runs`}
          className="text-sm font-medium text-[var(--color-fg)]"
        >
          {runs}
        </span>
        <span className="text-2xs text-[var(--color-fg-mute)]">
          {runs === 1 ? "run" : "runs"}
        </span>
      </div>
      <div
        data-testid={`${testId}-attempts`}
        className="font-mono text-2xs text-[var(--color-fg-soft)]"
      >
        {attempts} {attempts === 1 ? "attempt" : "attempts"}
      </div>
      <div className="font-mono text-2xs text-[var(--color-fg-soft)]">
        {formatCost(cost)}
      </div>
    </div>
  );
}

export function TraceMiniView({
  taskId,
  workflowName,
  stepName,
}: TraceMiniViewProps) {
  const navigate = useNavigate();

  const {
    executions: taskExecutions,
    isLoading: isTaskLoading,
    error: taskError,
  } = useTaskExecutions(taskId);

  const {
    rollups: subtreeRollups,
    isLoading: isSubtreeLoading,
    error: subtreeError,
  } = useSubtreeExecutions(taskId);

  const logsByExecutionId = useSessionLogStore(
    (state) => state.logsByExecutionId
  );

  const taskRollups = useMemo(
    () => computeExecutionRollups(taskExecutions, logsByExecutionId),
    [taskExecutions, logsByExecutionId]
  );

  const lastExecution = useMemo(
    () => pickLastExecution(taskExecutions),
    [taskExecutions]
  );

  const isLoading = isTaskLoading || isSubtreeLoading;
  const error = taskError ?? subtreeError;

  const handleExplore = () => {
    navigate(`/traces/${taskId}`);
  };

  const handleDetach = useCallback(async () => {
    await popOut(`/traces-window/${taskId}`, `traces-${taskId}`, {
      title: "Traces",
      width: 1100,
      height: 800,
    });
  }, [taskId]);

  return (
    <div
      className="m-4 rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-bg-2)] p-3"
      data-testid="trace-mini-view"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          {workflowName || stepName ? (
            <StatusBadge
              state={{
                kind: "workflow",
                workflow: workflowName ?? "",
                step: stepName ?? "",
              }}
            />
          ) : (
            <span className="text-[var(--color-fg-mute)] italic">No workflow</span>
          )}
        </div>
        {lastExecution?.status && (
          <StatusPill status={lastExecution.status} />
        )}
      </div>

      {lastExecution && (
        <div
          data-testid="trace-mini-last-exec"
          className="mt-2 flex items-center gap-3 font-mono text-2xs text-[var(--color-fg-mute)]"
        >
          <span>
            {formatDuration(
              lastExecution.started_at,
              lastExecution.completed_at
            )}
            {!lastExecution.completed_at && lastExecution.started_at
              ? " (running)"
              : ""}
          </span>
          {(() => {
            const c = parseCost(lastExecution.cost);
            return c !== null ? <span>{formatCost(c)}</span> : null;
          })()}
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <RollupCard
          testId="trace-mini-rollup-task"
          label="This task"
          runs={taskRollups.totalRuns}
          attempts={taskRollups.totalAttempts}
          cost={taskRollups.totalCost}
        />
        <RollupCard
          testId="trace-mini-rollup-subtree"
          label="Subtree"
          runs={subtreeRollups.totalRuns}
          attempts={subtreeRollups.totalAttempts}
          cost={subtreeRollups.totalCost}
          accent
        />
      </div>

      {isLoading && (
        <div className="mt-2 text-2xs text-[var(--color-fg-mute)] italic">
          Loading traces...
        </div>
      )}
      {error && !isLoading && (
        <div className="mt-2 rounded-[var(--radius-md)] border border-[color-mix(in_oklch,var(--color-err)_30%,transparent)] bg-[var(--color-err-wash)] px-2 py-1 text-2xs text-[var(--color-err)]">
          {error}
        </div>
      )}

      <div className="mt-3 flex items-stretch gap-2">
        <button
          type="button"
          onClick={handleExplore}
          data-testid="trace-mini-explore"
          className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-line-strong)] bg-[var(--color-bg-3)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-fg)] transition-colors hover:bg-[var(--color-bg-4)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-wash)]"
        >
          <span>Explore traces</span>
          <svg
            className="h-3 w-3"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M17 8l4 4m0 0l-4 4m4-4H3"
            />
          </svg>
        </button>
        <button
          type="button"
          onClick={handleDetach}
          data-testid="trace-mini-detach"
          aria-label="Detach traces into a separate window"
          title="Detach into separate window"
          className="cursor-pointer flex shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-line-strong)] bg-[var(--color-bg-3)] px-2.5 py-1.5 text-[var(--color-fg)] transition-colors hover:bg-[var(--color-bg-4)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-wash)]"
        >
          <svg
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M14 5l7 7m0 0l-7 7m7-7H3"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
