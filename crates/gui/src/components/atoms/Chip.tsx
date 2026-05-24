import type { ReactNode } from "react";

export type ChipVariant = "static" | "filter" | "input";

interface ChipProps {
  variant?: ChipVariant;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  onDismiss?: () => void;
  children: ReactNode;
  className?: string;
  /** When set, used as the accessible label for the dismiss button. */
  dismissLabel?: string;
}

const base =
  "inline-flex items-center gap-1.5 h-6 px-2.5 max-w-full truncate " +
  "font-sans text-xs font-medium rounded-[var(--radius-sm)] " +
  "border transition-[background-color,border-color,color] duration-[var(--t-fast)] ease-[var(--ease-default)]";

const variantClasses: Record<ChipVariant, string> = {
  static:
    "bg-[var(--color-bg-2)] border-[var(--color-line-strong)] text-[var(--color-fg-soft)]",
  filter:
    "bg-transparent border-[var(--color-line-strong)] text-[var(--color-fg-soft)] cursor-pointer hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]",
  input:
    "bg-[var(--color-bg-2)] border-[var(--color-line-strong)] text-[var(--color-fg)]",
};

const activeClasses =
  "bg-[var(--color-accent-wash)] border-[var(--color-accent)] text-[var(--color-accent)]";

/**
 * Compact label. Filter chips toggle on click; input chips can be dismissed.
 */
export function Chip({
  variant = "static",
  active = false,
  disabled = false,
  onClick,
  onDismiss,
  children,
  className,
  dismissLabel = "Remove",
}: ChipProps) {
  const isInteractive = variant === "filter" && !disabled;
  const Component = isInteractive ? "button" : "span";

  const classes = [
    base,
    variantClasses[variant],
    active && activeClasses,
    disabled && "opacity-50 cursor-not-allowed",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Component
      type={isInteractive ? "button" : undefined}
      className={classes}
      onClick={isInteractive ? onClick : undefined}
      aria-pressed={variant === "filter" ? active : undefined}
      disabled={isInteractive ? disabled : undefined}
    >
      <span className="truncate">{children}</span>
      {variant === "input" && onDismiss && !disabled && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full text-[var(--color-fg-mute)] hover:text-[var(--color-fg)]"
          aria-label={dismissLabel}
        >
          ×
        </button>
      )}
    </Component>
  );
}
