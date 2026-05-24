interface ContextMeterProps {
  /** Tokens used so far. */
  used: number;
  /** Max tokens in the context window. Pass 0/undefined to render nothing. */
  max: number | undefined;
  className?: string;
}

/**
 * Thin progress bar showing chat context window usage. Colour shifts from
 * accent → warn → err as the conversation approaches the limit per the spec.
 */
export function ContextMeter({ used, max, className }: ContextMeterProps) {
  if (!max || max <= 0) return null;
  const ratio = Math.min(1, Math.max(0, used / max));
  const pct = Math.round(ratio * 100);

  const fillVar =
    ratio >= 0.9
      ? "--color-err"
      : ratio >= 0.7
        ? "--color-warn"
        : "--color-accent";

  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`Context usage ${pct}%`}
      title={`${used.toLocaleString()} / ${max.toLocaleString()} tokens (${pct}%)`}
      className={[
        "relative h-1 w-full overflow-hidden rounded-full bg-[var(--color-bg-2)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div
        className="h-full rounded-full transition-[width] duration-[var(--t-base)] ease-[var(--ease-default)]"
        style={{ width: `${pct}%`, backgroundColor: `var(${fillVar})` }}
      />
    </div>
  );
}
