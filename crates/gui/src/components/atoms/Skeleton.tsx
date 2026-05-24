export type SkeletonVariant = "text" | "block" | "circle";

interface SkeletonProps {
  variant?: SkeletonVariant;
  width?: number | string;
  height?: number | string;
  className?: string;
}

const base =
  "inline-block bg-[var(--color-bg-2)] animate-pulse";

const variantClasses: Record<SkeletonVariant, string> = {
  text: "h-3 rounded-[var(--radius-xs)]",
  block: "rounded-[var(--radius-md)]",
  circle: "rounded-full",
};

function toUnit(value: number | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" ? `${value}px` : value;
}

/**
 * Loading placeholder. Mimics the shape of the content it precedes — use the
 * smallest unit that approximates the layout.
 */
export function Skeleton({
  variant = "text",
  width,
  height,
  className,
}: SkeletonProps) {
  const w = toUnit(width);
  const h = toUnit(height);
  const defaultWidth = variant === "text" ? "100%" : undefined;

  return (
    <span
      aria-hidden
      className={[base, variantClasses[variant], className]
        .filter(Boolean)
        .join(" ")}
      style={{
        width: w ?? defaultWidth,
        height: h,
      }}
    />
  );
}
