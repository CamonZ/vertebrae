import { useCallback } from 'react';
import type { TaskLevel, TaskFilterOptions } from '../../bindings';

export type ViewMode = 'list' | 'tree';
export type TaskFiltersValue = Omit<TaskFilterOptions, 'include_done'>;

interface TaskFiltersProps {
  filters: TaskFiltersValue;
  onFiltersChange: (filters: TaskFiltersValue) => void;
  viewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
}

/** Available level options for filtering */
const LEVEL_OPTIONS: { value: TaskLevel; label: string }[] = [
  { value: 'epic', label: 'Epic' },
  { value: 'ticket', label: 'Ticket' },
  { value: 'task', label: 'Task' },
];

/**
 * TaskFilters component with neural-pathway design.
 * Includes level dropdown, search, and view mode toggle.
 */
export function TaskFilters({
  filters,
  onFiltersChange,
  viewMode = 'list',
  onViewModeChange,
}: TaskFiltersProps) {
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

  const handleClearFilters = useCallback(() => {
    onFiltersChange({
      ...filters,
      levels: null,
      search: null,
    });
  }, [filters, onFiltersChange]);

  const hasActiveFilters =
    filters.levels ||
    filters.search;

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

      {/* View mode toggle */}
      {onViewModeChange && (
        <div className="ml-auto flex items-center rounded-lg border border-border bg-bg-tertiary/50 p-1">
          <button
            type="button"
            onClick={() => onViewModeChange('tree')}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-all ${
              viewMode === 'tree'
                ? 'bg-primary/10 text-primary'
                : 'text-text-muted hover:text-text-primary'
            }`}
            aria-label="Tree view"
            aria-pressed={viewMode === 'tree'}
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
                strokeWidth={1.5}
                d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z"
              />
            </svg>
            Tree
          </button>
          <button
            type="button"
            onClick={() => onViewModeChange('list')}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-all ${
              viewMode === 'list'
                ? 'bg-primary/10 text-primary'
                : 'text-text-muted hover:text-text-primary'
            }`}
            aria-label="List view"
            aria-pressed={viewMode === 'list'}
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
                strokeWidth={1.5}
                d="M4 6h16M4 10h16M4 14h16M4 18h16"
              />
            </svg>
            List
          </button>
        </div>
      )}
    </div>
  );
}
