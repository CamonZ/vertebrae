import type { StepExecution, ExecutionStatus } from '../../bindings';
import { useTaskExecutions } from '../../hooks';

interface ExecutionHistoryProps {
  taskId: string;
}

/**
 * Format datetime for display
 */
function formatDateTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoString;
  }
}

/**
 * Calculate duration between two timestamps
 */
function formatDuration(startedAt: string, completedAt: string | null): string {
  if (!completedAt) return 'Running...';

  try {
    const start = new Date(startedAt).getTime();
    const end = new Date(completedAt).getTime();
    const durationMs = end - start;

    if (durationMs < 1000) {
      return `${durationMs}ms`;
    } else if (durationMs < 60000) {
      return `${Math.round(durationMs / 1000)}s`;
    } else if (durationMs < 3600000) {
      const mins = Math.floor(durationMs / 60000);
      const secs = Math.round((durationMs % 60000) / 1000);
      return `${mins}m ${secs}s`;
    } else {
      const hours = Math.floor(durationMs / 3600000);
      const mins = Math.round((durationMs % 3600000) / 60000);
      return `${hours}h ${mins}m`;
    }
  } catch {
    return '-';
  }
}

/**
 * Get status styling
 */
function getStatusStyles(status: ExecutionStatus): {
  bg: string;
  border: string;
  text: string;
  glow?: string;
} {
  switch (status) {
    case 'in_progress':
      return {
        bg: 'bg-warning/10',
        border: 'border-warning',
        text: 'text-warning',
        glow: 'shadow-[0_0_12px_rgba(245,158,11,0.4)]',
      };
    case 'completed':
      return {
        bg: 'bg-success/10',
        border: 'border-success',
        text: 'text-success',
      };
    case 'failed':
      return {
        bg: 'bg-error/10',
        border: 'border-error',
        text: 'text-error',
      };
    default:
      return {
        bg: 'bg-bg-tertiary',
        border: 'border-border',
        text: 'text-text-muted',
      };
  }
}

/**
 * Timeline node with neural-inspired styling
 */
function TimelineNode({ status }: { status: ExecutionStatus }) {
  const styles = getStatusStyles(status);
  const isActive = status === 'in_progress';

  return (
    <div className={`relative flex h-5 w-5 items-center justify-center rounded-full border-2 ${styles.bg} ${styles.border} ${styles.glow ?? ''}`}>
      {isActive && (
        <>
          {/* Pulse ring */}
          <span className="absolute inset-0 animate-ping rounded-full border-2 border-warning opacity-30" />
          {/* Inner dot */}
          <span className="h-2 w-2 rounded-full bg-warning" />
        </>
      )}
      {status === 'completed' && (
        <svg className={`h-3 w-3 ${styles.text}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
        </svg>
      )}
      {status === 'failed' && (
        <svg className={`h-3 w-3 ${styles.text}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
        </svg>
      )}
    </div>
  );
}

/**
 * Single execution entry in the timeline
 */
function ExecutionEntry({ execution, isLast, index }: { execution: StepExecution; isLast: boolean; index: number }) {
  const styles = getStatusStyles(execution.status);
  const isActive = execution.status === 'in_progress';

  return (
    <div
      className="relative flex gap-4 animate-fade-in-up"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      {/* Timeline connector */}
      <div className="flex flex-col items-center">
        <TimelineNode status={execution.status} />
        {!isLast && (
          <div className={`mt-1 w-0.5 flex-1 ${isActive ? 'animate-signal-flow' : ''}`}>
            <div className="h-full w-full bg-gradient-to-b from-border via-border to-transparent" />
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 pb-6">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h4 className="text-sm font-medium text-text-primary">{execution.step_name}</h4>
            <p className="mt-0.5 text-xs text-text-muted">
              {formatDateTime(execution.started_at)}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${styles.bg} ${styles.text}`}>
              {isActive ? 'Active' : execution.status}
            </span>
            <span className="font-mono text-[10px] text-text-muted">
              {formatDuration(execution.started_at, execution.completed_at)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * ExecutionHistory displays a timeline of workflow step executions.
 * Features neural-pathway-inspired animations and styling.
 */
export function ExecutionHistory({ taskId }: ExecutionHistoryProps) {
  const { executions, isLoading, error } = useTaskExecutions(taskId);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="flex flex-col items-center gap-3">
          <div className="relative">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-primary" />
            <div className="absolute inset-0 animate-pulse rounded-full bg-primary/10" />
          </div>
          <p className="text-xs text-text-muted">Loading history...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-center">
        <p className="rounded-lg border border-error/20 bg-error/5 px-3 py-2 font-mono text-xs text-error">{error}</p>
      </div>
    );
  }

  if (executions.length === 0) {
    return (
      <div className="relative p-8 text-center">
        {/* Neural grid background */}
        <div className="neural-grid pointer-events-none absolute inset-0 opacity-20" />

        <div className="relative">
          <svg
            className="mx-auto h-12 w-12 text-text-muted"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1}
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <p className="mt-3 text-sm font-medium text-text-primary">No execution history</p>
          <p className="mt-1 text-xs text-text-muted">
            Task hasn't been processed through a workflow yet
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4">
      <h3 className="mb-4 font-mono text-[10px] uppercase tracking-wider text-text-muted">
        Execution Timeline
      </h3>
      <div className="relative">
        {/* Signal flow overlay for active executions */}
        {executions.some(e => e.status === 'in_progress') && (
          <div className="animate-signal-flow pointer-events-none absolute inset-0 opacity-30" />
        )}

        {executions.map((execution, index) => (
          <ExecutionEntry
            key={execution.id ?? `${execution.step_name}-${index}`}
            execution={execution}
            isLast={index === executions.length - 1}
            index={index}
          />
        ))}
      </div>
    </div>
  );
}
