import { useState, type ReactNode } from "react";
import { Badge } from "../atoms/Badge";

interface SectionGroupProps {
  label: ReactNode;
  /** Optional leading icon rendered before the label. */
  icon?: ReactNode;
  /** Item count shown as a badge in the header. Accepts a ratio like "5/13". */
  count?: number | string;
  /** Custom trailing badge (rendered instead of `count`). */
  badge?: ReactNode;
  /** Initial open state. Use `open` for fully controlled behaviour. */
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
  className?: string;
  /** aria-label override for the toggle button (defaults to the label text). */
  ariaLabel?: string;
  /** Optional testId on the section root. */
  testId?: string;
}

/**
 * Collapsible labeled section used inside detail panels. The header click
 * target spans the whole row; the chevron rotates 90° when expanded.
 */
export function SectionGroup({
  label,
  icon,
  count,
  badge,
  defaultOpen = false,
  open: controlled,
  onOpenChange,
  children,
  className,
  ariaLabel,
  testId,
}: SectionGroupProps) {
  const isControlled = controlled !== undefined;
  const [internal, setInternal] = useState(defaultOpen);
  const open = isControlled ? (controlled as boolean) : internal;

  function toggle() {
    const next = !open;
    if (!isControlled) setInternal(next);
    onOpenChange?.(next);
  }

  return (
    <section
      data-testid={testId}
      className={["border-t border-[var(--color-line)]", className]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-label={ariaLabel}
        className="sticky top-0 z-10 flex w-full items-center gap-2 bg-[var(--color-bg-1)] px-4 py-2.5 text-left text-sm font-medium text-[var(--color-fg)] hover:bg-[var(--color-bg-2)]"
      >
        <span
          aria-hidden
          className={[
            "inline-block text-xs text-[var(--color-fg-mute)] transition-transform duration-[var(--t-base)] ease-[var(--ease-default)]",
            open ? "rotate-90" : "",
          ].join(" ")}
        >
          ▸
        </span>
        {icon && (
          <span aria-hidden className="text-[var(--color-fg-mute)]">
            {icon}
          </span>
        )}
        <span className="flex-1 truncate">{label}</span>
        {badge !== undefined
          ? badge
          : count !== undefined && <Badge count={count} intent="neutral" />}
      </button>
      <div
        className={[
          "grid overflow-hidden transition-[grid-template-rows] duration-[var(--t-base)] ease-[var(--ease-default)]",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        ].join(" ")}
      >
        <div className="min-h-0 px-4 pb-3">{children}</div>
      </div>
    </section>
  );
}
