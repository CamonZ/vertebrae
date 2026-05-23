import type { ReactNode } from "react";

interface RunSummary {
  completed: number;
  failed: number;
  running: number;
}

interface NodeActionPopoverProps {
  /** True when there's a run actively executing for this node. */
  isRunning: boolean;
  /** Elapsed time of the active run, formatted (e.g., "0:47"). */
  elapsed?: string | null;
  summary?: RunSummary;
  primaryLabel?: ReactNode;
  onPrimary?: () => void;
  onStop?: () => void;
  className?: string;
}

/**
 * Compact floating action panel anchored below a selected pipeline node.
 * Provides quick run/stop affordances and a live run summary without
 * competing with the docked StepDetailPanel.
 */
export function NodeActionPopover({
  isRunning,
  elapsed,
  summary,
  primaryLabel = "▶ Run next task",
  onPrimary,
  onStop,
  className,
}: NodeActionPopoverProps) {
  return (
    <div
      role="dialog"
      aria-label="Node actions"
      className={[
        "inline-flex items-center gap-3 px-3 py-1.5",
        "rounded-[var(--radius-lg)] border border-[var(--color-line-strong)]",
        "bg-[var(--color-bg-3)] shadow-[var(--shadow-2)]",
        "font-sans text-xs text-[var(--color-fg)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {isRunning ? (
        <button
          type="button"
          onClick={onStop}
          className="inline-flex items-center gap-1.5 font-medium text-[var(--color-err)] hover:text-[var(--color-fg)]"
        >
          ■ Stop run
        </button>
      ) : (
        <button
          type="button"
          onClick={onPrimary}
          className="inline-flex items-center gap-1.5 font-medium text-[var(--color-accent)] hover:text-[var(--color-fg)]"
        >
          {primaryLabel}
        </button>
      )}
      <span
        aria-hidden
        className="h-3.5 w-px bg-[var(--color-line)]"
      />
      {isRunning && elapsed ? (
        <span className="font-mono text-[var(--color-fg-mute)]">
          ⟳ running · {elapsed}
        </span>
      ) : summary ? (
        <span className="inline-flex items-center gap-2 font-mono text-[var(--color-fg-mute)]">
          <span className="text-[var(--color-ok)]">✓ {summary.completed}</span>
          <span className="text-[var(--color-err)]">✗ {summary.failed}</span>
          <span className="text-[var(--color-info)]">⟳ {summary.running}</span>
        </span>
      ) : null}
    </div>
  );
}
