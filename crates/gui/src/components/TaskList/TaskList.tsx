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
 * Loading skeleton for the task list
 */
function LoadingSkeleton() {
  return (
    <div className="animate-pulse" role="status" aria-label="Loading tasks">
      {Array.from({ length: 5 }).map((_, index) => (
        <div
          key={index}
          className="flex items-center gap-4 border-b border-border px-4 py-3"
        >
          <div className="h-4 w-16 rounded bg-bg-tertiary" />
          <div className="h-4 flex-1 rounded bg-bg-tertiary" />
          <div className="h-5 w-14 rounded bg-bg-tertiary" />
          <div className="h-5 w-20 rounded-full bg-bg-tertiary" />
          <div className="h-5 w-14 rounded bg-bg-tertiary" />
        </div>
      ))}
      <span className="sr-only">Loading tasks...</span>
    </div>
  );
}

/**
 * Empty state when no tasks match the current filters
 */
function EmptyState() {
  return (
    <div
      className="flex flex-col items-center justify-center py-12 text-center"
      role="status"
    >
      <svg
        className="mb-4 h-12 w-12 text-text-muted"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
        />
      </svg>
      <p className="text-sm font-medium text-text-primary">No tasks found</p>
      <p className="mt-1 text-sm text-text-secondary">
        Try adjusting your filters or search criteria.
      </p>
    </div>
  );
}

/**
 * Error state when task fetching fails
 */
function ErrorState({ error }: { error: string }) {
  return (
    <div
      className="flex flex-col items-center justify-center py-12 text-center"
      role="alert"
    >
      <svg
        className="mb-4 h-12 w-12 text-error"
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
      <p className="text-sm font-medium text-text-primary">
        Failed to load tasks
      </p>
      <p className="mt-1 text-sm text-error">{error}</p>
    </div>
  );
}

/**
 * TaskList component displays a table of tasks with loading and empty states.
 * Uses TaskRow for individual task display.
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
          <tr className="border-b border-border bg-bg-secondary">
            <th
              scope="col"
              className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-secondary"
            >
              ID
            </th>
            <th
              scope="col"
              className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-secondary"
            >
              Title
            </th>
            <th
              scope="col"
              className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-secondary"
            >
              Level
            </th>
            <th
              scope="col"
              className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-secondary"
            >
              Status
            </th>
            <th
              scope="col"
              className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-secondary"
            >
              Priority
            </th>
          </tr>
        </thead>
        <tbody>
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
