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
      className="inline-flex items-center gap-1 rounded-md border border-[var(--color-line)] bg-[var(--color-bg-2)] p-0.5"
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
            className={`rounded px-3 py-1 text-xs font-medium uppercase tracking-wider transition-colors ${
              isActive
                ? "bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                : "text-[var(--color-fg-mute)] hover:text-[var(--color-fg-soft)]"
            }`}
          >
            {MODE_LABELS[m]}
          </button>
        );
      })}
    </div>
  );
}
