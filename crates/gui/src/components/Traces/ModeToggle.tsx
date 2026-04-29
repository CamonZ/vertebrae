import type { ReactNode } from "react";

export type TraceMode = "thread" | "corridor" | "strip";

export const TRACE_MODES: readonly TraceMode[] = [
  "thread",
  "corridor",
  "strip",
] as const;

interface ModeToggleProps {
  mode: TraceMode;
  onChange: (mode: TraceMode) => void;
}

const MODE_LABELS: Record<TraceMode, string> = {
  thread: "Thread",
  corridor: "Corridor",
  strip: "Strip",
};

const MODE_DESCRIPTIONS: Record<TraceMode, string> = {
  thread: "Continuous unified chat across the subtree.",
  corridor: "Per-task lanes side-by-side.",
  strip: "Compact strip of execution events.",
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
            className={`rounded px-3 py-1 text-xs font-medium uppercase tracking-wider transition-colors ${
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

export function ModePlaceholder({ mode }: { mode: TraceMode }): ReactNode {
  return (
    <div
      data-testid="trace-mode-placeholder"
      data-mode={mode}
      className="flex h-full flex-col items-center justify-center rounded-lg border border-dashed border-border bg-bg-tertiary/30 p-8 text-center"
    >
      <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
        {MODE_LABELS[mode]} mode
      </div>
      <div className="mt-2 text-sm font-medium text-text-primary">
        Coming soon
      </div>
      <div className="mt-1 max-w-md text-xs text-text-muted">
        {MODE_DESCRIPTIONS[mode]}
      </div>
    </div>
  );
}
