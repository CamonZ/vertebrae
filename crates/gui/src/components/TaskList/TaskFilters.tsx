import { useCallback } from 'react';
import type { TaskLevel, TaskFilterOptions } from '../../bindings';
import { ExpandCollapseAllButton } from './ExpandCollapseAllButton';

interface TaskFiltersProps {
  filters: TaskFilterOptions;
  onFiltersChange: (filters: TaskFilterOptions) => void;
  allExpanded?: boolean;
  onToggleExpandAll?: () => void;
  expandAllDisabled?: boolean;
}

const LEVEL_OPTIONS: { value: TaskLevel; label: string }[] = [
  { value: 'epic', label: 'Epic' },
  { value: 'ticket', label: 'Ticket' },
  { value: 'task', label: 'Task' },
];

export function TaskFilters({
  filters,
  onFiltersChange,
  allExpanded = false,
  onToggleExpandAll,
  expandAllDisabled,
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

  const hasActiveFilters = filters.levels || filters.search;
  const selectedLevel = filters.levels?.[0] ?? '';

  return (
    <div className="flex w-full flex-wrap items-center gap-3">
      {/* Search input */}
      <div className="relative min-w-48 flex-1">
        <input
          type="text"
          placeholder="Search tasks by title or ID..."
          value={filters.search ?? ''}
          onChange={handleSearchChange}
          className="h-8 w-full rounded-md border border-border bg-bg-tertiary px-3 pl-9 text-sm text-text-primary placeholder:text-text-muted transition-all focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          aria-label="Search tasks by title or ID"
          data-testid="task-search-input"
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

      {/* Level filter */}
      <div className="flex h-8 shrink-0 items-center rounded-md border border-border bg-bg-tertiary/50 px-1">
        <label
          htmlFor="level-filter"
          className="px-2 font-mono text-xs uppercase tracking-wider text-text-muted"
        >
          Level
        </label>
        <select
          id="level-filter"
          value={selectedLevel}
          onChange={handleLevelChange}
          className="rounded-sm border-0 bg-transparent px-1 py-0.5 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          <option value="">All</option>
          {LEVEL_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {/* Clear filters button */}
      {hasActiveFilters && (
        <button
          type="button"
          onClick={handleClearFilters}
          className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-bg-tertiary/50 px-3 text-xs text-text-muted transition-all hover:border-error/30 hover:bg-error/10 hover:text-error focus:outline-none focus:ring-2 focus:ring-error/20"
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

      {/* Expand/Collapse all */}
      {onToggleExpandAll && (
        <div className="ml-auto">
          <ExpandCollapseAllButton
            allExpanded={allExpanded}
            onToggle={onToggleExpandAll}
            disabled={expandAllDisabled}
          />
        </div>
      )}
    </div>
  );
}
