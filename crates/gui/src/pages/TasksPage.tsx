import { useState, useCallback, useMemo } from 'react';
import type { TaskFilterOptions, TaskSummary } from '../bindings';
import { useTasks } from '../hooks/useTasks';
import { TaskList, TaskFilters } from '../components/TaskList';
import { TaskDetailPanel } from '../components/TaskDetail';

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
 * Features neural-pathway-inspired design with animated elements.
 */
export function TasksPage() {
  const [filters, setFilters] = useState<TaskFilterOptions>(INITIAL_FILTERS);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const memoizedFilters = useMemo(() => filters, [filters]);
  const { tasks, isLoading, error, refetch } = useTasks(memoizedFilters);

  const handleFiltersChange = useCallback((newFilters: TaskFilterOptions) => {
    setFilters(newFilters);
  }, []);

  const handleTaskSelect = useCallback((task: TaskSummary) => {
    setSelectedTaskId(task.id);
  }, []);

  const handleClosePanel = useCallback(() => {
    setSelectedTaskId(null);
  }, []);

  const handleRelatedTaskSelect = useCallback((taskId: string) => {
    setSelectedTaskId(taskId);
  }, []);

  // Count active tasks
  const activeCount = tasks.filter(t => t.status === 'in_progress').length;

  return (
    <div className="flex min-h-0 flex-1">
      {/* Main content area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header section */}
        <div className="relative border-b border-border bg-bg-primary px-6 py-4">
          {/* Neural grid background */}
          <div className="neural-grid pointer-events-none absolute inset-0 opacity-20" />

          <div className="relative mb-4 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <h1 className="text-lg font-semibold text-text-primary">Tasks</h1>
              {activeCount > 0 && (
                <div className="flex items-center gap-2 rounded-full border border-warning/30 bg-warning/10 px-3 py-1">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-warning" />
                  </span>
                  <span className="text-xs font-medium text-warning">
                    {activeCount} active
                  </span>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={refetch}
              disabled={isLoading}
              className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-sm font-medium text-primary transition-all hover:border-primary hover:bg-primary hover:text-bg-primary hover:shadow-glow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
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
                  strokeWidth={1.5}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              {isLoading ? 'Loading...' : 'Refresh'}
            </button>
          </div>

          {/* Filter controls */}
          <div className="relative">
            <TaskFilters filters={filters} onFiltersChange={handleFiltersChange} />
          </div>
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
          <div className="flex items-center justify-between border-t border-border bg-bg-secondary px-6 py-2">
            <p className="font-mono text-xs text-text-muted">
              {tasks.length} task{tasks.length !== 1 ? 's' : ''}
            </p>
            {selectedTaskId && (
              <p className="font-mono text-xs text-text-muted">
                Selected: <span className="text-primary">{selectedTaskId.slice(0, 6)}</span>
              </p>
            )}
          </div>
        )}
      </div>

      {/* Task detail side panel */}
      <TaskDetailPanel
        taskId={selectedTaskId}
        onClose={handleClosePanel}
        onTaskSelect={handleRelatedTaskSelect}
      />
    </div>
  );
}
