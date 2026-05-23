import { Spinner } from "../../Spinner";

export interface RunningStepCount {
  /** Step identity used for the React key and the click handler payload. */
  id: string;
  /** Step display name (e.g., "In Progress"). */
  name: string;
  count: number;
}

interface LiveExecutionBannerProps {
  /** Total number of active runs across all steps. */
  totalRunning: number;
  /** Per-step running counts; rendered as clickable chips. */
  steps: RunningStepCount[];
  onStepClick?: (id: string) => void;
  className?: string;
}

/**
 * Floating pill at the top of the pipeline canvas summarising active runs.
 * Auto-hides when nothing is running — render unconditionally and let the
 * consumer decide when to mount it.
 */
export function LiveExecutionBanner({
  totalRunning,
  steps,
  onStepClick,
  className,
}: LiveExecutionBannerProps) {
  if (totalRunning <= 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={[
        "inline-flex items-center gap-2 px-3 py-1.5",
        "rounded-full border border-[var(--color-line-strong)]",
        "bg-[var(--color-bg-3)] shadow-[var(--shadow-2)]",
        "font-sans text-xs text-[var(--color-fg)]",
        "animate-fade-in-up",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <Spinner className="h-3 w-3 text-[var(--color-accent)]" />
      <span className="font-medium">{totalRunning} running</span>
      {steps.map((s) => (
        <span key={s.id} className="inline-flex items-center gap-1">
          <span aria-hidden className="text-[var(--color-fg-faint)]">·</span>
          <button
            type="button"
            onClick={() => onStepClick?.(s.id)}
            className="inline-flex items-center gap-1 rounded-[var(--radius-xs)] px-1 text-[var(--color-fg-soft)] hover:text-[var(--color-accent)]"
          >
            {s.name} ({s.count})
          </button>
        </span>
      ))}
    </div>
  );
}
