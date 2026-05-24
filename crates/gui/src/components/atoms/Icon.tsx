import type { ReactNode, SVGProps } from "react";

export type IconSize = "xs" | "sm" | "md" | "lg" | "xl";

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  size?: IconSize;
  /** Accessible label. When provided the icon becomes role="img"; otherwise it is aria-hidden. */
  label?: string;
  /** SVG path content rendered inside the icon's viewBox. */
  children: ReactNode;
}

const sizePx: Record<IconSize, number> = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
  xl: 24,
};

/**
 * Inline SVG icon wrapper. Inherits currentColor; treats decorative icons as
 * aria-hidden by default and exposes a label opt-in for meaningful icons.
 */
export function Icon({
  size = "md",
  label,
  viewBox = "0 0 24 24",
  className,
  children,
  ...rest
}: IconProps) {
  const px = sizePx[size];
  const labelProps = label
    ? { role: "img" as const, "aria-label": label }
    : { "aria-hidden": true as const };

  return (
    <svg
      width={px}
      height={px}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...labelProps}
      {...rest}
    >
      {children}
    </svg>
  );
}
