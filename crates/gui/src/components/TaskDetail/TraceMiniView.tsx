import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type { ExecutionStatus, StepExecution } from "../../bindings";
import { useTaskExecutions } from "../../hooks";
import { useSubtreeExecutions } from "../../hooks/useSubtreeExecutions";
import { useSessionLogStore } from "../../stores/sessionLogStore";
import { computeExecutionRollups, formatCost, parseCost } from "../../utils";
import { formatDuration } from "../Operations/formatDuration";

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
      return { bg: "bg-warning/10", text: "text-warning" };
    case "completed":
      return { bg: "bg-success/10", text: "text-success" };
    case "failed":
      return { bg: "bg-error/10", text: "text-error" };
    default:
      return { bg: "bg-bg-tertiary", text: "text-text-muted" };
  }
}

function StatusPill({ status }: { status: ExecutionStatus }) {
  const styles = getStatusStyles(status);
  return (
    <span
      data-testid="trace-mini-status"
      data-status={status}
      className={`inline-flex flex-shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${styles.bg} ${styles.text}`}
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
  cost: number;
  testId: string;
  accent?: boolean;
}

function RollupCard({ label, runs, cost, testId, accent }: RollupCardProps) {
  const containerClass = accent
    ? "rounded border border-primary/30 bg-primary/5 px-2 py-1.5"
    : "rounded border border-border bg-bg-tertiary/50 px-2 py-1.5";
  const labelClass = accent
    ? "font-mono text-[9px] uppercase tracking-wider text-primary"
    : "font-mono text-[9px] uppercase tracking-wider text-text-muted";
  return (
    <div data-testid={testId} className={containerClass}>
      <div className={labelClass}>{label}</div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className="text-sm font-medium text-text-primary">{runs}</span>
        <span className="text-[10px] text-text-muted">runs</span>
      </div>
      <div className="font-mono text-[10px] text-text-secondary">
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

  return (
    <div
      className="m-4 rounded-lg border border-border bg-bg-secondary p-3"
      data-testid="trace-mini-view"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          {workflowName ? (
            <span className="truncate font-medium text-text-secondary">
              {workflowName}
            </span>
          ) : (
            <span className="text-text-muted italic">No workflow</span>
          )}
          {stepName && (
            <>
              <svg
                className="h-3 w-3 flex-shrink-0 text-text-muted"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
              <span className="truncate text-text-secondary">
                {stepName.replace(/_/g, " ")}
              </span>
            </>
          )}
        </div>
        {lastExecution?.status && (
          <StatusPill status={lastExecution.status} />
        )}
      </div>

      {lastExecution && (
        <div
          data-testid="trace-mini-last-exec"
          className="mt-2 flex items-center gap-3 font-mono text-[10px] text-text-muted"
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
          cost={taskRollups.totalCost}
        />
        <RollupCard
          testId="trace-mini-rollup-subtree"
          label="Subtree"
          runs={subtreeRollups.totalRuns}
          cost={subtreeRollups.totalCost}
          accent
        />
      </div>

      {isLoading && (
        <div className="mt-2 text-[10px] text-text-muted italic">
          Loading traces...
        </div>
      )}
      {error && !isLoading && (
        <div className="mt-2 rounded border border-error/20 bg-error/5 px-2 py-1 text-[10px] text-error">
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={handleExplore}
        data-testid="trace-mini-explore"
        className="mt-3 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border-strong bg-bg-tertiary px-2.5 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
    </div>
  );
}
