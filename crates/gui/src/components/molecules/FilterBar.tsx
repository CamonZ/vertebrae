import type { ReactNode } from "react";
import { Chip } from "../atoms/Chip";

export interface ActiveFilter {
  id: string;
  label: ReactNode;
  /** Optional dismiss handler. When omitted the chip is non-dismissible. */
  onClear?: () => void;
}

interface FilterBarProps {
  /** Left slot — typically a SearchInput. */
  search?: ReactNode;
  /** Center/right slot — Select / Chip group filter controls. */
  filters?: ReactNode;
  /** When any filter is active, these chips render below the main bar. */
  active?: ActiveFilter[];
  onClearAll?: () => void;
  className?: string;
}

/**
 * Horizontal control row for narrowing a list. Active filter chips appear
 * underneath so the user can dismiss them individually.
 */
export function FilterBar({
  search,
  filters,
  active,
  onClearAll,
  className,
}: FilterBarProps) {
  const hasActive = active && active.length > 0;
  return (
    <div className={["flex flex-col gap-2", className].filter(Boolean).join(" ")}>
      <div className="flex flex-wrap items-center gap-2">
        {search && <div className="min-w-[220px] flex-1">{search}</div>}
        {filters && (
          <div className="flex flex-wrap items-center gap-2">{filters}</div>
        )}
        {hasActive && onClearAll && (
          <button
            type="button"
            onClick={onClearAll}
            className="ml-auto text-xs text-[var(--color-fg-mute)] hover:text-[var(--color-accent)]"
          >
            ✕ Clear filters
          </button>
        )}
      </div>
      {hasActive && (
        <div
          role="group"
          aria-label="Active filters"
          className="flex flex-wrap items-center gap-1.5"
        >
          {active!.map((f) => (
            <Chip
              key={f.id}
              variant="input"
              onDismiss={f.onClear}
              dismissLabel={`Remove filter`}
            >
              {f.label}
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}
