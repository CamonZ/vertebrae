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
  if (!completedAt) return 'In progress';

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
function getStatusStyles(status: ExecutionStatus): { bg: string; text: string; icon: string } {
  switch (status) {
    case 'in_progress':
      return {
        bg: 'bg-amber-100 dark:bg-amber-900/30',
        text: 'text-amber-700 dark:text-amber-400',
        icon: 'animate-pulse',
      };
    case 'completed':
      return {
        bg: 'bg-green-100 dark:bg-green-900/30',
        text: 'text-green-700 dark:text-green-400',
        icon: '',
      };
    case 'failed':
      return {
        bg: 'bg-red-100 dark:bg-red-900/30',
        text: 'text-red-700 dark:text-red-400',
        icon: '',
      };
    default:
      return {
        bg: 'bg-gray-100 dark:bg-gray-700',
        text: 'text-gray-700 dark:text-gray-300',
        icon: '',
      };
  }
}

/**
 * Status icon component
 */
function StatusIcon({ status }: { status: ExecutionStatus }) {
  const styles = getStatusStyles(status);

  if (status === 'in_progress') {
    return (
      <div className={`h-3 w-3 rounded-full ${styles.bg} ${styles.icon}`}>
        <div className="h-full w-full rounded-full bg-amber-500 dark:bg-amber-400" />
      </div>
    );
  }

  if (status === 'completed') {
    return (
      <svg className={`h-4 w-4 ${styles.text}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
    );
  }

  if (status === 'failed') {
    return (
      <svg className={`h-4 w-4 ${styles.text}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
      </svg>
    );
  }

  return null;
}

/**
 * Single execution entry in the timeline
 */
function ExecutionEntry({ execution, isLast }: { execution: StepExecution; isLast: boolean }) {
  const styles = getStatusStyles(execution.status);

  return (
    <div className="relative flex gap-3">
      {/* Timeline line */}
      {!isLast && (
        <div className="absolute left-[7px] top-6 h-[calc(100%-12px)] w-0.5 bg-border" />
      )}

      {/* Status indicator */}
      <div className={`mt-1 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full ${styles.bg}`}>
        <StatusIcon status={execution.status} />
      </div>

      {/* Content */}
      <div className="flex-1 pb-4">
        <div className="flex items-center justify-between">
          <span className="font-medium text-text-primary">{execution.step_name}</span>
          <span className={`text-xs ${styles.text}`}>
            {execution.status === 'in_progress' ? 'Running' : execution.status}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
          <span>Started: {formatDateTime(execution.started_at)}</span>
          {execution.completed_at && (
            <span>Duration: {formatDuration(execution.started_at, execution.completed_at)}</span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * ExecutionHistory displays a timeline of workflow step executions for a task.
 * Shows how the task has progressed through different workflow steps over time.
 */
export function ExecutionHistory({ taskId }: ExecutionHistoryProps) {
  const { executions, isLoading, error } = useTaskExecutions(taskId);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <svg className="h-6 w-6 animate-spin text-primary" fill="none" viewBox="0 0 24 24">
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-center">
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      </div>
    );
  }

  if (executions.length === 0) {
    return (
      <div className="p-8 text-center">
        <svg
          className="mx-auto h-10 w-10 text-text-muted"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <p className="mt-2 text-sm text-text-muted">No execution history</p>
        <p className="mt-1 text-xs text-text-muted">
          This task hasn't been processed through a workflow yet.
        </p>
      </div>
    );
  }

  return (
    <div className="p-4">
      <h3 className="mb-4 text-xs font-semibold uppercase tracking-wide text-text-muted">
        Execution Timeline
      </h3>
      <div className="space-y-0">
        {executions.map((execution, index) => (
          <ExecutionEntry
            key={execution.id ?? `${execution.step_name}-${index}`}
            execution={execution}
            isLast={index === executions.length - 1}
          />
        ))}
      </div>
    </div>
  );
}
