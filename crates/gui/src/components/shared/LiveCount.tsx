interface LiveCountProps {
  /**
   * Number of live/running items. The readout is hidden entirely when this is
   * zero, matching the prototype's `LiveCount` (docs/design/lib/lib-shell.jsx).
   */
  running: number;
  className?: string;
}

/**
 * The Hearth "N running" pulse readout used in topbar activity slots
 * (prototype `.app-topbar .activity .live`). Accent-colored text with a small
 * glowing pulse dot — no filled pill background.
 *
 * Shared so Board/Operations topbars can reuse the same live-execution
 * vocabulary. Returns null when `running` is zero.
 */
export function LiveCount({ running, className = "" }: LiveCountProps) {
  if (running <= 0) return null;

  return (
    <span
      data-testid="topbar-live-count"
      className={`inline-flex items-center gap-1.5 font-medium text-[var(--color-accent)] ${className}`}
    >
      <span className="relative inline-flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-accent)] opacity-75" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] shadow-[0_0_8px_var(--color-accent-glow)]" />
      </span>
      {running} running
    </span>
  );
}
