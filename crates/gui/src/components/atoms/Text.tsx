import type { ElementType, HTMLAttributes, ReactNode } from "react";

export type TextVariant =
  | "display"
  | "heading-xl"
  | "heading-lg"
  | "heading-md"
  | "lede"
  | "body"
  | "body-sm"
  | "label"
  | "caption"
  | "eyebrow"
  | "mono"
  | "mono-sm";

export type TextColor =
  | "primary"
  | "secondary"
  | "tertiary"
  | "faint"
  | "accent"
  | "ok"
  | "warn"
  | "err"
  | "info"
  | "inherit";

interface TextProps extends Omit<HTMLAttributes<HTMLElement>, "color"> {
  variant?: TextVariant;
  color?: TextColor;
  as?: ElementType;
  truncate?: boolean;
  italic?: boolean;
  children?: ReactNode;
}

const variantClass: Record<TextVariant, string> = {
  display: "font-serif text-[clamp(72px,11vw,140px)] leading-[0.92] tracking-tight font-normal",
  "heading-xl": "font-serif text-5xl leading-none tracking-tight font-normal",
  "heading-lg": "font-serif text-4xl leading-[1.05] tracking-tight font-normal",
  "heading-md": "font-sans text-xl leading-tight font-medium",
  lede: "font-serif text-[1.375rem] leading-[1.45] font-light italic",
  body: "font-sans text-base leading-relaxed font-normal",
  "body-sm": "font-sans text-sm leading-snug font-normal",
  label: "font-sans text-sm leading-snug font-medium",
  caption: "font-sans text-xs leading-snug font-normal",
  eyebrow: "font-mono text-[0.6875rem] uppercase tracking-[0.16em] font-medium",
  mono: "font-mono text-sm leading-relaxed font-normal",
  "mono-sm": "font-mono text-xs leading-snug font-normal",
};

const colorClass: Record<TextColor, string> = {
  primary: "text-[var(--color-fg)]",
  secondary: "text-[var(--color-fg-soft)]",
  tertiary: "text-[var(--color-fg-mute)]",
  faint: "text-[var(--color-fg-faint)]",
  accent: "text-[var(--color-accent)]",
  ok: "text-[var(--color-ok)]",
  warn: "text-[var(--color-warn)]",
  err: "text-[var(--color-err)]",
  info: "text-[var(--color-info)]",
  inherit: "",
};

const defaultElement: Record<TextVariant, ElementType> = {
  display: "h1",
  "heading-xl": "h1",
  "heading-lg": "h2",
  "heading-md": "h3",
  lede: "p",
  body: "p",
  "body-sm": "p",
  label: "span",
  caption: "span",
  eyebrow: "span",
  mono: "span",
  "mono-sm": "span",
};

/**
 * Typographic primitive. Routes every visible string through one component so
 * the type scale stays consistent and theme-aware.
 */
export function Text({
  variant = "body",
  color = "inherit",
  as,
  truncate,
  italic,
  className,
  children,
  ...rest
}: TextProps) {
  const Component = as ?? defaultElement[variant];
  const classes = [
    variantClass[variant],
    colorClass[color],
    italic && "italic",
    truncate && "block max-w-full overflow-hidden text-ellipsis whitespace-nowrap",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Component className={classes} {...rest}>
      {children}
    </Component>
  );
}
