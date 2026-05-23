import type { HTMLAttributes, ReactNode } from "react";

export type CardVariant = "default" | "flat" | "interactive";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  header?: ReactNode;
  footer?: ReactNode;
  /** Action slot rendered to the right of the header title. */
  headerAction?: ReactNode;
}

const baseClasses =
  "bg-[var(--color-bg-1)] border rounded-[var(--radius-lg)] " +
  "transition-[border-color,background-color,box-shadow] duration-[var(--t-base)] ease-[var(--ease-default)]";

const variantClasses: Record<CardVariant, string> = {
  default: "border-[var(--color-line)]",
  flat: "border-transparent bg-[var(--color-bg-1)]",
  interactive:
    "border-[var(--color-line)] cursor-pointer hover:bg-[var(--color-bg-2)] hover:border-[var(--color-line-strong)]",
};

/**
 * Surface container with optional header / footer slots. The interactive
 * variant makes the entire card the click target.
 */
export function Card({
  variant = "default",
  header,
  footer,
  headerAction,
  className,
  children,
  ...rest
}: CardProps) {
  const classes = [baseClasses, variantClasses[variant], className]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} {...rest}>
      {header && (
        <div className="flex items-center justify-between gap-3 border-b border-[var(--color-line)] px-4 py-3">
          <div className="min-w-0 flex-1 truncate font-sans text-sm font-medium text-[var(--color-fg)]">
            {header}
          </div>
          {headerAction && (
            <div className="shrink-0 text-[var(--color-fg-mute)]">
              {headerAction}
            </div>
          )}
        </div>
      )}
      <div className="px-4 py-3">{children}</div>
      {footer && (
        <div className="border-t border-[var(--color-line)] px-4 py-3 text-sm text-[var(--color-fg-soft)]">
          {footer}
        </div>
      )}
    </div>
  );
}
