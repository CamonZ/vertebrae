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

const FILTER_LABEL_CLASS =
  "flex items-center gap-1 rounded-full border border-[var(--color-line)] bg-[var(--color-bg-2)] px-2 py-1 text-[var(--color-fg-soft)]";
const FILTER_SELECT_CLASS =
  "border-0 bg-transparent px-1 py-0 text-xs text-[var(--color-fg)] outline-none";

function uniqueSorted(values: Iterable<string | null | undefined>): string[] {
  const set = new Set<string>();
  for (const v of values) {
    if (v && v.trim().length > 0) set.add(v);
  }
  return Array.from(set).sort();
}

function FilterSelect({
  testId,
  label,
  value,
  options,
  onChange,
}: {
  testId: string;
  label: string;
  value: string | null | undefined;
  options: readonly string[];
  onChange: (value: string | null) => void;
}): ReactNode {
  const handleChange = (e: ChangeEvent<HTMLSelectElement>): void => {
    const val = e.target.value;
    onChange(val === "" ? null : val);
  };

  return (
    <label className={FILTER_LABEL_CLASS}>
      <span className="font-mono text-2xs uppercase tracking-wider text-[var(--color-fg-mute)]">
        {label}
      </span>
      <select
        data-testid={testId}
        className={FILTER_SELECT_CLASS}
        value={value ?? ""}
        onChange={handleChange}
      >
        <option value="">All</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
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

    return (
      <div
        data-testid="trace-filter-bar"
        data-variant="hearth-v2"
        className="flex flex-wrap items-center gap-2 border-b border-[var(--color-line)] bg-[var(--color-bg-1)] px-4 py-2 text-xs"
      >
        <FilterSelect
          testId="trace-filter-status"
          label="Status"
          value={filters.status}
          options={statuses}
          onChange={onStatusChange}
        />
        <FilterSelect
          testId="trace-filter-step"
          label="Step"
          value={filters.stepName}
          options={stepNames}
          onChange={onStepNameChange}
        />
        <FilterSelect
          testId="trace-filter-model"
          label="Model"
          value={filters.model}
          options={models}
          onChange={onModelChange}
        />

        <input
          ref={searchRef}
          data-testid="trace-filter-search"
          type="text"
          placeholder="Search events… (press / to focus)"
          className="min-w-[180px] flex-1 rounded-full border border-[var(--color-line)] bg-[var(--color-bg-2)] px-3 py-1 text-xs text-[var(--color-fg)] placeholder:text-[var(--color-fg-mute)]"
          value={filters.search}
          onChange={(e) => onSearchChange(e.target.value)}
        />

        <label
          data-testid="trace-filter-root-only-label"
          className={`flex cursor-pointer items-center gap-1 rounded-full border px-2 py-1 text-[var(--color-fg-soft)] ${
            filters.rootOnly
              ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10"
              : "border-[var(--color-line)] bg-[var(--color-bg-2)]"
          }`}
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
