import { useCallback } from 'react';
import type { TaskStatus, TaskLevel, TaskFilterOptions } from '../../bindings';

interface TaskFiltersProps {
  filters: TaskFilterOptions;
  onFiltersChange: (filters: TaskFilterOptions) => void;
}

/** Available status options for filtering */
const STATUS_OPTIONS: { value: TaskStatus; label: string }[] = [
  { value: 'backlog', label: 'Backlog' },
  { value: 'todo', label: 'Todo' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'pending_review', label: 'Review' },
  { value: 'done', label: 'Done' },
  { value: 'rejected', label: 'Rejected' },
];

/** Available level options for filtering */
const LEVEL_OPTIONS: { value: TaskLevel; label: string }[] = [
  { value: 'epic', label: 'Epic' },
  { value: 'ticket', label: 'Ticket' },
  { value: 'task', label: 'Task' },
];

/**
 * TaskFilters component provides filter controls for the task list.
 * Includes status dropdown, level dropdown, and search input.
 */
export function TaskFilters({ filters, onFiltersChange }: TaskFiltersProps) {
  const handleStatusChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const value = event.target.value;
      const statuses = value ? [value as TaskStatus] : null;
      onFiltersChange({ ...filters, statuses });
    },
    [filters, onFiltersChange]
  );

  const handleLevelChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const value = event.target.value;
      const levels = value ? [value as TaskLevel] : null;
      onFiltersChange({ ...filters, levels });
    },
    [filters, onFiltersChange]
  );

  const handleSearchChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const search = event.target.value || null;
      onFiltersChange({ ...filters, search });
    },
    [filters, onFiltersChange]
  );

  const handleIncludeDoneChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const include_done = event.target.checked;
      onFiltersChange({ ...filters, include_done });
    },
    [filters, onFiltersChange]
  );

  const handleClearFilters = useCallback(() => {
    onFiltersChange({
      statuses: null,
      levels: null,
      tags: null,
      root_only: null,
      children_of: null,
      include_done: null,
      search: null,
    });
  }, [onFiltersChange]);

  const hasActiveFilters =
    filters.statuses ||
    filters.levels ||
    filters.search ||
    filters.include_done;

  const selectedStatus = filters.statuses?.[0] ?? '';
  const selectedLevel = filters.levels?.[0] ?? '';

  return (
    <div className="flex flex-wrap items-center gap-4">
      {/* Search input */}
      <div className="relative flex-1 min-w-48">
        <input
          type="text"
          placeholder="Search tasks..."
          value={filters.search ?? ''}
          onChange={handleSearchChange}
          className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 pl-9 text-sm text-text-primary placeholder:text-text-muted focus:border-border-focus focus:outline-none focus:ring-1 focus:ring-border-focus"
          aria-label="Search tasks by title"
        />
        <svg
          className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
      </div>

      {/* Status filter */}
      <div className="flex items-center gap-2">
        <label
          htmlFor="status-filter"
          className="text-sm font-medium text-text-secondary"
        >
          Status
        </label>
        <select
          id="status-filter"
          value={selectedStatus}
          onChange={handleStatusChange}
          className="rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:border-border-focus focus:outline-none focus:ring-1 focus:ring-border-focus"
        >
          <option value="">All</option>
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {/* Level filter */}
      <div className="flex items-center gap-2">
        <label
          htmlFor="level-filter"
          className="text-sm font-medium text-text-secondary"
        >
          Level
        </label>
        <select
          id="level-filter"
          value={selectedLevel}
          onChange={handleLevelChange}
          className="rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:border-border-focus focus:outline-none focus:ring-1 focus:ring-border-focus"
        >
          <option value="">All</option>
          {LEVEL_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {/* Include done checkbox */}
      <label className="flex items-center gap-2 text-sm text-text-secondary">
        <input
          type="checkbox"
          checked={filters.include_done ?? false}
          onChange={handleIncludeDoneChange}
          className="h-4 w-4 rounded border-border text-primary focus:ring-border-focus"
        />
        Show done
      </label>

      {/* Clear filters button */}
      {hasActiveFilters && (
        <button
          type="button"
          onClick={handleClearFilters}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-border-focus"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
          Clear
        </button>
      )}
    </div>
  );
}
