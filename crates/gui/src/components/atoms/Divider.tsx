import type { ReactNode } from "react";

interface DividerProps {
  orientation?: "horizontal" | "vertical";
  label?: ReactNode;
  className?: string;
}

/**
 * Visual separator. Optional label centers on the rule.
 */
export function Divider({
  orientation = "horizontal",
  label,
  className,
}: DividerProps) {
  if (orientation === "vertical") {
    return (
      <span
        role="separator"
        aria-orientation="vertical"
        className={[
          "inline-block w-px self-stretch bg-[var(--color-line)]",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      />
    );
  }

  if (label) {
    return (
      <div
        role="separator"
        aria-orientation="horizontal"
        className={[
          "flex items-center gap-3 text-xs text-[var(--color-fg-mute)]",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <span className="h-px flex-1 bg-[var(--color-line)]" aria-hidden />
        <span>{label}</span>
        <span className="h-px flex-1 bg-[var(--color-line)]" aria-hidden />
      </div>
    );
  }

  return (
    <hr
      role="separator"
      aria-orientation="horizontal"
      className={[
        "h-px w-full border-0 bg-[var(--color-line)] m-0",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
}
