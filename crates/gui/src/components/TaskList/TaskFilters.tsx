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
  { value: 'in_progress', label: 'Active' },
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
 * TaskFilters component with neural-pathway design.
 * Includes status dropdown, level dropdown, search, and toggles.
 */
export function TaskFilters({ filters, onFiltersChange }: TaskFiltersProps) {
  const handleStatusChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const value = event.target.value;
      const statuses = value ? [value as TaskStatus] : null;
      // When 'All' is selected (no specific status), include done tasks to show everything
      const include_done = value ? filters.include_done : true;
      onFiltersChange({ ...filters, statuses, include_done });
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
      include_done: true, // Include done tasks when showing 'All' statuses
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
    <div className="flex flex-wrap items-center gap-3">
      {/* Search input */}
      <div className="relative min-w-48 flex-1">
        <input
          type="text"
          placeholder="Search tasks..."
          value={filters.search ?? ''}
          onChange={handleSearchChange}
          className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 pl-9 text-sm text-text-primary placeholder:text-text-muted transition-all focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
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
            strokeWidth={1.5}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
      </div>

      {/* Filters group */}
      <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-tertiary/50 p-1">
        {/* Status filter */}
        <div className="flex items-center">
          <label
            htmlFor="status-filter"
            className="px-2 font-mono text-[10px] uppercase tracking-wider text-text-muted"
          >
            Status
          </label>
          <select
            id="status-filter"
            value={selectedStatus}
            onChange={handleStatusChange}
            className="rounded-md border-0 bg-transparent px-2 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          >
            <option value="">All</option>
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="h-4 w-px bg-border" />

        {/* Level filter */}
        <div className="flex items-center">
          <label
            htmlFor="level-filter"
            className="px-2 font-mono text-[10px] uppercase tracking-wider text-text-muted"
          >
            Level
          </label>
          <select
            id="level-filter"
            value={selectedLevel}
            onChange={handleLevelChange}
            className="rounded-md border-0 bg-transparent px-2 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          >
            <option value="">All</option>
            {LEVEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="h-4 w-px bg-border" />

        {/* Include done toggle */}
        <label className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm text-text-secondary hover:text-text-primary">
          <div className="relative">
            <input
              type="checkbox"
              checked={filters.include_done ?? false}
              onChange={handleIncludeDoneChange}
              className="peer sr-only"
            />
            <div className="h-4 w-7 rounded-full bg-bg-tertiary transition-colors peer-checked:bg-primary/30" />
            <div className="absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-text-muted transition-all peer-checked:left-3.5 peer-checked:bg-primary" />
          </div>
          <span className="font-mono text-[10px] uppercase tracking-wider">Done</span>
        </label>
      </div>

      {/* Clear filters button */}
      {hasActiveFilters && (
        <button
          type="button"
          onClick={handleClearFilters}
          className="flex items-center gap-1.5 rounded-lg border border-border bg-bg-tertiary/50 px-3 py-1.5 text-xs text-text-muted transition-all hover:border-error/30 hover:bg-error/10 hover:text-error focus:outline-none focus:ring-2 focus:ring-error/20"
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
              strokeWidth={1.5}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
          Clear
        </button>
      )}
    </div>
  );
}
