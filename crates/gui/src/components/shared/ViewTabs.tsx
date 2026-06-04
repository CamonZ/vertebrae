import type { ReactNode } from "react";

export interface ViewTab {
  id: string;
  label: string;
  icon?: ReactNode;
}

interface ViewTabsProps {
  tabs: ViewTab[];
  value: string;
  onChange: (id: string) => void;
}

/**
 * Segmented control for switching between equivalent views of the same data
 * (e.g. List vs. Board). Mirrors the canonical `.view-tabs` from the Hearth
 * design library: mono labels, a recessed pill container, and a raised active
 * tab.
 */
export function ViewTabs({ tabs, value, onChange }: ViewTabsProps) {
  return (
    <div
      role="tablist"
      className="inline-flex rounded-[var(--radius-sm)] border border-[var(--color-line-strong)] bg-[var(--color-bg-1)] p-0.5"
    >
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={`inline-flex items-center gap-1.5 rounded-[var(--radius-xs)] px-2.5 py-1 font-mono text-[11px] tracking-[0.04em] transition-all duration-[var(--t-fast)] ${
              active
                ? "bg-[var(--color-bg-3)] text-[var(--color-fg)] shadow-[0_1px_3px_rgba(0,0,0,0.15)]"
                : "bg-transparent text-[var(--color-fg-mute)] hover:text-[var(--color-fg-soft)]"
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
