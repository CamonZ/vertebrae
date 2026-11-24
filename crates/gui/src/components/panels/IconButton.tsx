import { forwardRef, type ReactNode } from "react";

interface IconButtonProps {
  onClick: () => void;
  ariaLabel: string;
  title?: string;
  testId?: string;
  disabled?: boolean;
  /** A toggle's state (aria-pressed); omit for a plain action. */
  pressed?: boolean;
  /** Shortcut that also triggers this action (aria-keyshortcuts). */
  keyShortcuts?: string;
  children: ReactNode;
}

/**
 * Standard detail-panel icon button (close, delete, …). The shared
 * chrome control used across the task / step / workflow detail headers so every
 * floating panel presents the same 28px hit target and hover/focus treatment.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      onClick,
      ariaLabel,
      title,
      testId,
      disabled = false,
      pressed,
      keyShortcuts,
      children,
    },
    ref
  ) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        aria-pressed={pressed}
        aria-keyshortcuts={keyShortcuts}
        title={title}
        data-testid={testId}
        disabled={disabled}
        className="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] border border-transparent text-[var(--color-fg-mute)] transition-all hover:border-[var(--color-fg-faint)] hover:bg-[var(--color-bg-1)] hover:text-[var(--color-fg)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:text-[var(--color-fg-mute)] aria-pressed:text-[var(--color-accent)]"
      >
        {children}
      </button>
    );
  }
);
