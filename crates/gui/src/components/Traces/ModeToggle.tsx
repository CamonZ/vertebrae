import type { ReactNode } from "react";

export type TraceMode = "thread" | "corridor";

export const TRACE_MODES: readonly TraceMode[] = ["thread", "corridor"] as const;

interface ModeToggleProps {
  mode: TraceMode;
  onChange: (mode: TraceMode) => void;
}

const MODE_LABELS: Record<TraceMode, string> = {
  thread: "Thread",
  corridor: "Corridor",
};

export function ModeToggle({ mode, onChange }: ModeToggleProps): ReactNode {
  return (
    <div
      data-testid="trace-mode-toggle"
      className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-tertiary p-0.5"
      role="tablist"
      aria-label="Trace visualization mode"
    >
      {TRACE_MODES.map((m) => {
        const isActive = m === mode;
        return (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-testid={`trace-mode-option-${m}`}
            data-active={isActive}
            onClick={() => onChange(m)}
            className={`rounded px-3 py-1 text-[10px] font-medium uppercase tracking-wider transition-colors ${
              isActive
                ? "bg-primary/10 text-primary"
                : "text-text-muted hover:text-text-secondary"
            }`}
          >
            {MODE_LABELS[m]}
          </button>
        );
      })}
    </div>
  );
}
