import type { ReactNode } from "react";
import type { TaskLevel } from "../../bindings";
import { formatCost, formatTokenCount, type ExecutionRollups } from "../../utils";
import { formatDurationMs } from "../Operations/formatDuration";

interface TracesHeaderProps {
  taskId: string | null;
  title: string | null;
  level: TaskLevel | null;
  rollups: ExecutionRollups;
  isLoading?: boolean;
  error?: string | null;
  onBack?: () => void;
}

interface RollupStatProps {
  label: string;
  value: string;
  testId: string;
}

function RollupStat({ label, value, testId }: RollupStatProps): ReactNode {
  return (
    <div
      data-testid={testId}
      className="flex flex-col rounded border border-border bg-bg-tertiary/50 px-3 py-1.5"
    >
      <span className="font-mono text-[9px] uppercase tracking-wider text-text-muted">
        {label}
      </span>
      <span className="text-sm font-medium text-text-primary">{value}</span>
    </div>
  );
}

export function TracesHeader({
  taskId,
  title,
  level,
  rollups,
  isLoading,
  error,
  onBack,
}: TracesHeaderProps): ReactNode {
  const hasTask = taskId != null;
  const displayTitle = hasTask ? (title ?? "Unknown task") : "Pick a task to explore traces";
  const displayLevel = level ?? "task";

  return (
    <header
      data-testid="traces-header"
      data-task-id={taskId ?? ""}
      className="flex flex-col gap-3 border-b border-border bg-bg-secondary px-4 py-3"
    >
      <div className="flex items-center gap-3">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            data-testid="traces-back-button"
            className="flex items-center gap-1 rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-bg-hover"
            aria-label="Back"
          >
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
                d="M15 19l-7-7 7-7"
              />
            </svg>
            <span>Back</span>
          </button>
        )}

        <nav
          aria-label="Breadcrumb"
          data-testid="traces-breadcrumb"
          className="flex items-center gap-1 text-xs text-text-muted"
        >
          <span>Traces</span>
          {hasTask && (
            <>
              <span aria-hidden="true">/</span>
              <span
                data-testid="traces-breadcrumb-level"
                className="font-mono uppercase tracking-wider"
              >
                {displayLevel}
              </span>
            </>
          )}
        </nav>

        <h1
          data-testid="traces-title"
          className="truncate text-base font-semibold text-text-primary"
        >
          {displayTitle}
        </h1>
      </div>

      {hasTask && (
      <div
        data-testid="traces-rollup"
        className="flex flex-wrap items-stretch gap-2"
      >
        <RollupStat
          testId="traces-rollup-runs"
          label="Σ Runs"
          value={String(rollups.totalRuns)}
        />
        <RollupStat
          testId="traces-rollup-cost"
          label="Σ Cost"
          value={formatCost(rollups.totalCost)}
        />
        <RollupStat
          testId="traces-rollup-tokens"
          label="Σ Tokens"
          value={formatTokenCount(rollups.totalTokens)}
        />
        <RollupStat
          testId="traces-rollup-walltime"
          label="Σ Wall Time"
          value={formatDurationMs(rollups.totalWallTimeMs)}
        />
        {isLoading && (
          <span
            data-testid="traces-rollup-loading"
            className="self-center text-[10px] text-text-muted italic"
          >
            Loading...
          </span>
        )}
        {error && !isLoading && (
          <span
            data-testid="traces-rollup-error"
            className="self-center rounded border border-error/20 bg-error/5 px-2 py-1 text-[10px] text-error"
          >
            {error}
          </span>
        )}
      </div>
      )}
    </header>
  );
}
