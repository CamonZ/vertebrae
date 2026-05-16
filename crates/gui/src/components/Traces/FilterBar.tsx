/**
 * FilterBar — shared, URL-backed filter UI for the Traces explorer.
 *
 * Drives status / step / model filters plus a free-text search and a
 * "Root only" toggle. The same filter state feeds THREAD, FLIGHT-STRIP and
 * CORRIDOR rendering, so a filter change narrows all three consistently.
 */

import { forwardRef, useMemo, type ChangeEvent, type ReactNode } from "react";
import type { StepExecution } from "../../bindings";
import type { TraceFilters } from "../../hooks/useTraceFilters";

interface FilterBarProps {
  filters: TraceFilters;
  executions: readonly StepExecution[];
  onStatusChange: (value: string | null) => void;
  onStepNameChange: (value: string | null) => void;
  onModelChange: (value: string | null) => void;
  onSearchChange: (value: string) => void;
  onRootOnlyChange: (value: boolean) => void;
}

function uniqueSorted(values: Iterable<string | null | undefined>): string[] {
  const set = new Set<string>();
  for (const v of values) {
    if (v && v.trim().length > 0) set.add(v);
  }
  return Array.from(set).sort();
}

export const FilterBar = forwardRef<HTMLInputElement, FilterBarProps>(
  function FilterBar(
    {
      filters,
      executions,
      onStatusChange,
      onStepNameChange,
      onModelChange,
      onSearchChange,
      onRootOnlyChange,
    },
    searchRef
  ): ReactNode {
    const statuses = useMemo(
      () => uniqueSorted(executions.map((e) => e.status ?? null)),
      [executions]
    );
    const stepNames = useMemo(
      () => uniqueSorted(executions.map((e) => e.step_name ?? null)),
      [executions]
    );
    const models = useMemo(
      () => uniqueSorted(executions.map((e) => e.model ?? null)),
      [executions]
    );

    const handleSelect =
      (cb: (v: string | null) => void) =>
      (e: ChangeEvent<HTMLSelectElement>): void => {
        const val = e.target.value;
        cb(val === "" ? null : val);
      };

    return (
      <div
        data-testid="trace-filter-bar"
        className="flex flex-wrap items-center gap-2 border-b border-border bg-bg-secondary px-3 py-2 text-xs"
      >
        <label className="flex items-center gap-1 text-text-secondary">
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
            Status
          </span>
          <select
            data-testid="trace-filter-status"
            className="rounded border border-border bg-bg-primary px-1 py-0.5 text-xs text-text-primary"
            value={filters.status ?? ""}
            onChange={handleSelect(onStatusChange)}
          >
            <option value="">All</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1 text-text-secondary">
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
            Step
          </span>
          <select
            data-testid="trace-filter-step"
            className="rounded border border-border bg-bg-primary px-1 py-0.5 text-xs text-text-primary"
            value={filters.stepName ?? ""}
            onChange={handleSelect(onStepNameChange)}
          >
            <option value="">All</option>
            {stepNames.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1 text-text-secondary">
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
            Model
          </span>
          <select
            data-testid="trace-filter-model"
            className="rounded border border-border bg-bg-primary px-1 py-0.5 text-xs text-text-primary"
            value={filters.model ?? ""}
            onChange={handleSelect(onModelChange)}
          >
            <option value="">All</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <input
          ref={searchRef}
          data-testid="trace-filter-search"
          type="text"
          placeholder="Search events… (press / to focus)"
          className="min-w-[180px] flex-1 rounded border border-border bg-bg-primary px-2 py-0.5 text-xs text-text-primary placeholder:text-text-muted"
          value={filters.search}
          onChange={(e) => onSearchChange(e.target.value)}
        />

        <label
          data-testid="trace-filter-root-only-label"
          className="flex cursor-pointer items-center gap-1 text-text-secondary"
        >
          <input
            data-testid="trace-filter-root-only"
            type="checkbox"
            checked={filters.rootOnly}
            onChange={(e) => onRootOnlyChange(e.target.checked)}
            className="h-3 w-3"
          />
          Root only
        </label>
      </div>
    );
  }
);
