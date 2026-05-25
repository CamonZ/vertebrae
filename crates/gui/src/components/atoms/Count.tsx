import type { HTMLAttributes } from "react";

interface CountProps extends HTMLAttributes<HTMLSpanElement> {
  value: number;
}

/**
 * Canonical Hearth count numeral: Newsreader serif italic in copper
 * (var(--color-accent)), faint (var(--color-fg-faint)) when zero. The single
 * voice for every "count attached to a grouping" — kanban column totals,
 * operations section counts, pipeline tab counts, task child counts — so they
 * read identically across surfaces.
 *
 * Font-size is intentionally inherited; pass a `text-*` class to size it for
 * the context (e.g. `text-[16px]` on a kanban header, `text-2xs` in a dense
 * gutter). `tabular-nums` keeps multi-digit counts from shifting on update.
 */
export function Count({ value, className, ...rest }: CountProps) {
  const classes = [
    "font-serif italic tabular-nums leading-none",
    value === 0 ? "text-[var(--color-fg-faint)]" : "text-[var(--color-accent)]",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={classes} {...rest}>
      {value}
    </span>
  );
}
