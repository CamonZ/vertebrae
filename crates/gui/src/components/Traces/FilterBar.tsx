/**
 * FilterBar — the Traces scope-chip row (canonical design).
 *
 * A single `view` scope narrows the rendered thread stream by message type
 * (Threads · Turns · Tools · System · Errors) or by agent model, with live
 * counts on each chip, plus a free-text search.
 */

import { forwardRef, type ReactNode } from "react";
import type { ViewCounts } from "./viewFilter";

interface FilterBarProps {
  view: string;
  counts: ViewCounts;
  search: string;
  onViewChange: (value: string) => void;
  onSearchChange: (value: string) => void;
}

function ScopeChip({
  id,
  label,
  n,
  active,
  err,
  onClick,
}: {
  id: string;
  label: string;
  n: number | null;
  active: boolean;
  err?: boolean;
  onClick: () => void;
}): ReactNode {
  const base =
    "inline-flex items-center gap-1 rounded-[var(--radius-sm)] border px-2.5 py-1 font-sans text-xs cursor-pointer transition-colors";
  const tone = active
    ? err
      ? "border-[color-mix(in_oklch,var(--color-err)_35%,transparent)] bg-[var(--color-err-wash)] text-[var(--color-err)]"
      : "border-[color-mix(in_oklch,var(--color-accent)_30%,transparent)] bg-[var(--color-accent-wash)] text-[var(--color-accent)]"
    : "border-transparent text-[var(--color-fg-mute)] hover:bg-[var(--color-bg-1)]";
  const badge = active
    ? err
      ? "bg-[color-mix(in_oklch,var(--color-err)_25%,var(--color-bg))] text-[var(--color-err)]"
      : "bg-[color-mix(in_oklch,var(--color-accent)_25%,var(--color-bg))] text-[var(--color-accent)]"
    : "bg-[var(--color-bg-3)] text-[var(--color-fg-faint)]";
  return (
    <span
      role="button"
      tabIndex={0}
      data-testid={`trace-scope-${id}`}
      data-active={active ? "true" : "false"}
      className={`${base} ${tone}`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {label}
      {n != null && (
        <span
          className={`rounded-[var(--radius-xs)] px-1 font-mono text-2xs ${badge}`}
        >
          {n}
        </span>
      )}
    </span>
  );
}

export const FilterBar = forwardRef<HTMLInputElement, FilterBarProps>(
  function FilterBar(
    { view, counts, search, onViewChange, onSearchChange },
    searchRef
  ): ReactNode {
    const modelIds = Object.keys(counts.models).sort();

    return (
      <div
        data-testid="trace-filter-bar"
        data-variant="hearth-v2"
        className="flex flex-wrap items-center gap-2 border-b border-[var(--color-line)] bg-[var(--color-bg-1)] px-4 py-2 text-xs"
      >
        <ScopeChip id="all" label="All" n={counts.all} active={view === "all"} onClick={() => onViewChange("all")} />
        <ScopeChip id="threads" label="Threads" n={counts.threads} active={view === "threads"} onClick={() => onViewChange("threads")} />
        <ScopeChip id="turns" label="Turns" n={counts.turns} active={view === "turns"} onClick={() => onViewChange("turns")} />
        <ScopeChip id="tools" label="Tools" n={counts.tools} active={view === "tools"} onClick={() => onViewChange("tools")} />
        <ScopeChip id="system" label="System" n={counts.system} active={view === "system"} onClick={() => onViewChange("system")} />
        <ScopeChip id="errors" label="Errors" n={counts.errors} err active={view === "errors"} onClick={() => onViewChange("errors")} />

        {modelIds.length > 0 && (
          <span className="mx-1 h-3.5 w-px bg-[var(--color-line)]" aria-hidden="true" />
        )}
        {modelIds.map((id) => (
          <ScopeChip
            key={id}
            id={id}
            label={id}
            n={counts.models[id]}
            active={view === id}
            onClick={() => onViewChange(id)}
          />
        ))}

        <input
          ref={searchRef}
          data-testid="trace-filter-search"
          type="text"
          placeholder="Search the thread… (press / to focus)"
          className="ml-auto min-w-[180px] max-w-[360px] flex-1 rounded-full border border-[var(--color-line)] bg-[var(--color-bg-2)] px-3 py-1 text-xs text-[var(--color-fg)] placeholder:text-[var(--color-fg-mute)]"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>
    );
  }
);
