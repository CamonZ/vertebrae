import type { TaskSummary } from '../../bindings';
import { TaskRow } from './TaskRow';

interface TaskListProps {
  tasks: TaskSummary[];
  isLoading: boolean;
  error: string | null;
  selectedTaskId?: string | null;
  onTaskSelect?: (task: TaskSummary) => void;
}

/**
 * Loading skeleton with neural pulse effect
 */
function LoadingSkeleton() {
  return (
    <div className="relative" role="status" aria-label="Loading tasks">
      {/* Signal flow animation overlay */}
      <div className="animate-signal-flow pointer-events-none absolute inset-0" />

      {Array.from({ length: 6 }).map((_, index) => (
        <div
          key={index}
          className="flex items-center gap-4 border-b border-border px-4 py-3"
          style={{ animationDelay: `${index * 50}ms` }}
        >
          <div className="h-4 w-14 animate-pulse rounded bg-bg-tertiary" />
          <div className="h-4 flex-1 animate-pulse rounded bg-bg-tertiary" />
          <div className="h-5 w-12 animate-pulse rounded bg-bg-tertiary" />
          <div className="h-5 w-16 animate-pulse rounded-full bg-bg-tertiary" />
          <div className="h-4 w-8 animate-pulse rounded bg-bg-tertiary" />
          <div className="flex gap-1">
            <div className="h-5 w-12 animate-pulse rounded-full bg-bg-tertiary" />
            <div className="h-5 w-10 animate-pulse rounded-full bg-bg-tertiary" />
          </div>
        </div>
      ))}
      <span className="sr-only">Loading tasks...</span>
    </div>
  );
}

/**
 * Empty state with neural aesthetic
 */
function EmptyState() {
  return (
    <div
      className="relative flex flex-col items-center justify-center py-16 text-center"
      role="status"
    >
      {/* Neural grid background */}
      <div className="neural-grid pointer-events-none absolute inset-0 opacity-20" />

      <div className="relative">
        <svg
          className="mx-auto mb-4 h-16 w-16 text-text-muted"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1}
            d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
          />
        </svg>
        <p className="text-sm font-medium text-text-primary">No tasks found</p>
        <p className="mt-1 text-xs text-text-muted">
          Adjust filters or create a new task
        </p>
      </div>
    </div>
  );
}

/**
 * Error state with error glow effect
 */
function ErrorState({ error }: { error: string }) {
  return (
    <div
      className="flex flex-col items-center justify-center py-16 text-center"
      role="alert"
    >
      <div className="relative">
        {/* Error glow */}
        <div className="absolute inset-0 rounded-full bg-error/20 blur-xl" />

        <svg
          className="relative mx-auto mb-4 h-12 w-12 text-error"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
      </div>
      <p className="text-sm font-medium text-text-primary">Failed to load tasks</p>
      <p className="mt-2 max-w-sm rounded-lg border border-error/20 bg-error/5 px-4 py-2 font-mono text-xs text-error">
        {error}
      </p>
    </div>
  );
}

/**
 * TaskList component displays a table of tasks with loading and empty states.
 * Uses the Neural Pathways design system.
 */
export function TaskList({
  tasks,
  isLoading,
  error,
  selectedTaskId,
  onTaskSelect,
}: TaskListProps) {
  if (error) {
    return <ErrorState error={error} />;
  }

  if (isLoading) {
    return <LoadingSkeleton />;
  }

  if (tasks.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-full table-auto" role="grid">
        <thead>
          <tr className="border-b border-border bg-bg-secondary/50">
            <th
              scope="col"
              className="whitespace-nowrap px-4 py-2.5 text-left font-mono text-[10px] font-medium uppercase tracking-wider text-text-muted"
            >
              ID
            </th>
            <th
              scope="col"
              className="whitespace-nowrap px-4 py-2.5 text-left font-mono text-[10px] font-medium uppercase tracking-wider text-text-muted"
            >
              Title
            </th>
            <th
              scope="col"
              className="whitespace-nowrap px-4 py-2.5 text-left font-mono text-[10px] font-medium uppercase tracking-wider text-text-muted"
            >
              Level
            </th>
            <th
              scope="col"
              className="whitespace-nowrap px-4 py-2.5 text-left font-mono text-[10px] font-medium uppercase tracking-wider text-text-muted"
            >
              Status
            </th>
            <th
              scope="col"
              className="whitespace-nowrap px-4 py-2.5 text-left font-mono text-[10px] font-medium uppercase tracking-wider text-text-muted"
            >
              Priority
            </th>
            <th
              scope="col"
              className="whitespace-nowrap px-4 py-2.5 text-left font-mono text-[10px] font-medium uppercase tracking-wider text-text-muted"
            >
              Tags
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              isSelected={selectedTaskId === task.id}
              onClick={onTaskSelect}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
