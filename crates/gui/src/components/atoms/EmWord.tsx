import type { HTMLAttributes, ReactNode } from "react";

interface EmWordProps extends HTMLAttributes<HTMLElement> {
  children?: ReactNode;
}

/**
 * Heading accent word (Hearth cursive role A): the ONE emphasised word inside
 * a serif heading or title, rendered Newsreader serif italic in copper
 * (var(--color-accent)).
 *
 * This is intentionally distinct from the other two cursive roles:
 *  - inline prose emphasis (<em>) is serif italic at full --fg, not copper;
 *  - ledes/subtitles/hints are muted weight-300 serif italic.
 *
 * Wrap exactly one word: `<Text variant="heading-lg">Implement <EmWord>JWT</EmWord> service</Text>`.
 */
export function EmWord({ className, children, ...rest }: EmWordProps) {
  const classes = ["font-serif italic text-[var(--color-accent)]", className]
    .filter(Boolean)
    .join(" ");

  return (
    <em className={classes} {...rest}>
      {children}
    </em>
  );
}
