import type { ReactNode } from "react";

export type BadgeIntent =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "error"
  | "info";

export type BadgeSize = "sm" | "md";

interface BadgeProps {
  intent?: BadgeIntent;
  size?: BadgeSize;
  /** Show a leading colored dot (or only the dot when there is no label). */
  dot?: boolean | "only";
  /** Render a count badge (small pill). Accepts a ratio string like "5/13". */
  count?: number | string;
  className?: string;
  /** Stable selector for integration/acceptance tests; sets data-testid. */
  testId?: string;
  children?: ReactNode;
}

const intentClasses: Record<BadgeIntent, string> = {
  neutral:
    "bg-[var(--color-bg-2)] text-[var(--color-fg-mute)] border-[var(--color-line-strong)]",
  accent:
    "bg-[var(--color-accent-wash)] text-[var(--color-accent)] border-[color-mix(in_oklch,var(--color-accent)_45%,transparent)]",
  success:
    "bg-[var(--color-ok-wash)] text-[var(--color-ok)] border-[color-mix(in_oklch,var(--color-ok)_35%,transparent)]",
  warning:
    "bg-[var(--color-warn-wash)] text-[var(--color-warn)] border-[color-mix(in_oklch,var(--color-warn)_35%,transparent)]",
  error:
    "bg-[var(--color-err-wash)] text-[var(--color-err)] border-[color-mix(in_oklch,var(--color-err)_40%,transparent)]",
  info:
    "bg-[var(--color-info-wash)] text-[var(--color-info)] border-[color-mix(in_oklch,var(--color-info)_35%,transparent)]",
};

const sizeClasses: Record<BadgeSize, string> = {
  sm: "h-[18px] px-1.5 text-2xs",
  md: "h-[22px] px-2 text-xs",
};

/**
 * Compact semantic label. Non-interactive; use Chip for toggleable surfaces.
 */
export function Badge({
  intent = "neutral",
  size = "sm",
  dot,
  count,
  className,
  testId,
  children,
}: BadgeProps) {
  if (count !== undefined) {
    return (
      <span
        data-testid={testId}
        className={[
          "inline-flex min-w-[18px] h-[18px] px-1.5 items-center justify-center",
          "rounded-full font-mono text-2xs font-medium",
          intentClasses[intent],
          "border max-w-full truncate",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {count}
      </span>
    );
  }

  const classes = [
    "inline-flex items-center gap-1.5 font-sans font-medium",
    "rounded-[var(--radius-sm)] border whitespace-nowrap max-w-full truncate",
    sizeClasses[size],
    intentClasses[intent],
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span data-testid={testId} className={classes}>
      {dot && (
        <span
          className="inline-block h-1.5 w-1.5 rounded-full bg-current"
          aria-hidden
        />
      )}
      {dot !== "only" && <span className="truncate">{children}</span>}
    </span>
  );
}
