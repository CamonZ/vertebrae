import type { ReactNode } from "react";

interface IconButtonProps {
  onClick: () => void;
  ariaLabel: string;
  title?: string;
  testId?: string;
  disabled?: boolean;
  children: ReactNode;
}

/**
 * Standard detail-panel icon button (close, delete, …). The shared
 * chrome control used across the task / step / workflow detail headers so every
 * floating panel presents the same 28px hit target and hover/focus treatment.
 */
export function IconButton({
  onClick,
  ariaLabel,
  title,
  testId,
  disabled = false,
  children,
}: IconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={title}
      data-testid={testId}
      disabled={disabled}
      className="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] border border-transparent text-[var(--color-fg-mute)] transition-all hover:border-[var(--color-fg-faint)] hover:bg-[var(--color-bg-1)] hover:text-[var(--color-fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:text-[var(--color-fg-mute)]"
    >
      {children}
    </button>
  );
}
