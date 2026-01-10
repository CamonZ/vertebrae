import { useState, useCallback, useMemo } from 'react';
import type { TaskFilterOptions, TaskSummary } from '../bindings';
import { useTasks } from '../hooks/useTasks';
import { TaskList, TaskFilters } from '../components/TaskList';

/**
 * Initial empty filter state
 */
const INITIAL_FILTERS: TaskFilterOptions = {
  statuses: null,
  levels: null,
  tags: null,
  root_only: null,
  children_of: null,
  include_done: null,
  search: null,
};

/**
 * TasksPage displays a filterable, searchable list of all tasks.
 * Uses the useTasks hook for data fetching and manages filter state locally.
 */
export function TasksPage() {
  const [filters, setFilters] = useState<TaskFilterOptions>(INITIAL_FILTERS);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // Memoize the filter object to prevent unnecessary re-renders
  const memoizedFilters = useMemo(() => filters, [filters]);

  // Fetch tasks with current filters
  const { tasks, isLoading, error, refetch } = useTasks(memoizedFilters);

  const handleFiltersChange = useCallback((newFilters: TaskFilterOptions) => {
    setFilters(newFilters);
  }, []);

  const handleTaskSelect = useCallback((task: TaskSummary) => {
    setSelectedTaskId(task.id);
    // TODO: Navigate to task detail or open side panel
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* Header section */}
      <div className="border-b border-border bg-bg-primary px-6 py-4">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold text-text-primary">Tasks</h1>
          <button
            type="button"
            onClick={refetch}
            disabled={isLoading}
            className="flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover focus:outline-none focus:ring-2 focus:ring-border-focus focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Refresh task list"
          >
            <svg
              className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            Refresh
          </button>
        </div>

        {/* Filter controls */}
        <TaskFilters filters={filters} onFiltersChange={handleFiltersChange} />
      </div>

      {/* Task list section */}
      <div className="flex-1 overflow-auto bg-bg-primary">
        <TaskList
          tasks={tasks}
          isLoading={isLoading}
          error={error}
          selectedTaskId={selectedTaskId}
          onTaskSelect={handleTaskSelect}
        />
      </div>

      {/* Footer with task count */}
      {!isLoading && !error && tasks.length > 0 && (
        <div className="border-t border-border bg-bg-secondary px-6 py-2">
          <p className="text-sm text-text-secondary">
            Showing {tasks.length} task{tasks.length !== 1 ? 's' : ''}
          </p>
        </div>
      )}
    </div>
  );
}
