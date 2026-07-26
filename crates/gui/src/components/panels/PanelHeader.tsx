import type { ReactNode } from "react";

interface PanelHeaderProps {
  /** Editable title slot — usually an InlineEditField. */
  title: ReactNode;
  /** Identity row content rendered below the title (IdentityBadge · workflow:step · StatusBadge). */
  metadata?: ReactNode;
  /** Right-aligned controls (close, more). */
  controls?: ReactNode;
  className?: string;
}

/**
 * Standardised detail-panel header. Slots own their content so the panel can
 * stay generic across task / step / workflow entities while still matching
 * the Hearth header anatomy from the design spec.
 */
export function PanelHeader({
  title,
  metadata,
  controls,
  className,
}: PanelHeaderProps) {
  return (
    <header
      className={[
        "flex flex-col gap-1 border-b border-[var(--color-line)] px-4 py-3",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 font-serif text-lg leading-snug text-[var(--color-fg)]">
          {title}
        </div>
        {controls && (
          <div className="shrink-0 inline-flex items-center gap-1">
            {controls}
          </div>
        )}
      </div>
      {metadata && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--color-fg-mute)]">
          {metadata}
        </div>
      )}
    </header>
  );
}
