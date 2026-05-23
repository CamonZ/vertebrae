import type { ReactNode } from "react";

interface EmptyStateProps {
  icon?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/**
 * Placeholder shown when a list or section has no content. Keep copy short —
 * one short title, optionally one explanation sentence and one action.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={[
        "flex flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {icon && (
        <div className="text-[var(--color-fg-mute)]" aria-hidden>
          {icon}
        </div>
      )}
      {title && (
        <div className="font-serif text-lg text-[var(--color-fg)]">{title}</div>
      )}
      {description && (
        <p className="max-w-[42ch] text-sm text-[var(--color-fg-soft)]">
          {description}
        </p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
