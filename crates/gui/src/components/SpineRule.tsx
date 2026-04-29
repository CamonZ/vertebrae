interface SpineRuleProps {
  segments?: number;
  className?: string;
}

/**
 * Articulated divider — a row of short equal-length segments separated by
 * gaps. Suggests articulation between major sections without drawing a
 * continuous rule.
 */
export function SpineRule({ segments = 7, className = "" }: SpineRuleProps) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      className={`flex w-full items-center justify-center gap-1.5 ${className}`}
    >
      {Array.from({ length: segments }).map((_, i) => (
        <span
          key={i}
          className="block h-px w-6 bg-border"
        />
      ))}
    </div>
  );
}
