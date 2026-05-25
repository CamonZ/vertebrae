import type { ReactNode } from "react";
import { Text } from "../atoms/Text";

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
 *
 * When no icon is supplied the state opens with the Hearth editorial mark: a
 * large serif-italic em-dash over a short copper rule — the same "blank page"
 * cue used across the docs reference. The description renders as a muted
 * weight-300 serif-italic lede (cursive role C).
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
      {icon ? (
        <div className="text-[var(--color-fg-mute)]" aria-hidden>
          {icon}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2" aria-hidden>
          <span className="font-serif text-5xl italic leading-none text-[var(--color-fg-faint)]">
            —
          </span>
          <span className="h-px w-10 bg-[var(--color-line-strong)]" />
        </div>
      )}
      {title && (
        <div className="font-serif text-lg text-[var(--color-fg)]">{title}</div>
      )}
      {description && (
        <Text
          variant="lede"
          color="tertiary"
          className="max-w-[42ch] text-base"
        >
          {description}
        </Text>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
