import { useCallback, useMemo } from "react";
import type { TaskLevel, TaskFilterOptions } from "../../bindings";
import { ExpandCollapseAllButton } from "./ExpandCollapseAllButton";
import { FilterBar, type ActiveFilter } from "../molecules/FilterBar";
import { SearchInput } from "../molecules/SearchInput";
import { Select } from "../atoms/Select";

interface TaskFiltersProps {
  filters: TaskFilterOptions;
  onFiltersChange: (filters: TaskFilterOptions) => void;
  allExpanded?: boolean;
  onToggleExpandAll?: () => void;
  expandAllDisabled?: boolean;
  className?: string;
}

const LEVEL_OPTIONS: { value: TaskLevel; label: string }[] = [
  { value: "epic", label: "Epic" },
  { value: "ticket", label: "Ticket" },
  { value: "task", label: "Task" },
];

const LEVEL_SELECT_OPTIONS = [
  { value: "", label: "All levels" },
  ...LEVEL_OPTIONS,
];

export function TaskFilters({
  filters,
  onFiltersChange,
  allExpanded = false,
  onToggleExpandAll,
  expandAllDisabled,
  className,
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
    (value: string) => {
      onFiltersChange({ ...filters, search: value || null });
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

  const selectedLevel = filters.levels?.[0] ?? "";

  // Active-filter chips rendered by FilterBar below the control row. Each is
  // individually dismissible; FilterBar also renders the clear-all affordance.
  const activeFilters = useMemo<ActiveFilter[]>(() => {
    const chips: ActiveFilter[] = [];
    if (filters.search) {
      chips.push({
        id: "search",
        label: `Search: ${filters.search}`,
        onClear: () => onFiltersChange({ ...filters, search: null }),
      });
    }
    if (filters.levels?.[0]) {
      const level = filters.levels[0];
      const label =
        LEVEL_OPTIONS.find((o) => o.value === level)?.label ?? level;
      chips.push({
        id: "level",
        label: `Level: ${label}`,
        onClear: () => onFiltersChange({ ...filters, levels: null }),
      });
    }
    return chips;
  }, [filters, onFiltersChange]);

  return (
    <FilterBar
      className={className}
      search={
        <SearchInput
          value={filters.search ?? ""}
          onChange={handleSearchChange}
          debounceMs={0}
          placeholder="Search tasks by title or ID..."
          aria-label="Search tasks by title or ID"
          data-testid="task-search-input"
        />
      }
      filters={
        <>
          <div className="w-40">
            <Select
              options={LEVEL_SELECT_OPTIONS}
              value={selectedLevel}
              onChange={handleLevelChange}
              aria-label="Filter by level"
              id="level-filter"
            />
          </div>
          {onToggleExpandAll && (
            <ExpandCollapseAllButton
              allExpanded={allExpanded}
              onToggle={onToggleExpandAll}
              disabled={expandAllDisabled}
            />
          )}
        </>
      }
      active={activeFilters}
      onClearAll={handleClearFilters}
    />
  );
}
