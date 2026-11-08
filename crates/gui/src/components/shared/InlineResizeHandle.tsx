import type { HTMLAttributes } from "react";
import "./InlineResizeHandle.css";

type Props = HTMLAttributes<HTMLSpanElement> & {
  label: string;
  value: number;
  minimum: number;
  maximum: number;
  resizing?: boolean;
};

/** Shared bottom grip for inline diffs and statecharts. */
export function InlineResizeHandle({
  label,
  value,
  minimum,
  maximum,
  resizing,
  ...handlers
}: Props) {
  return (
    <span
      {...handlers}
      className="evdiff-handle"
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      tabIndex={0}
      title="Drag to resize; use Up and Down arrow keys."
      data-resizing={resizing ? "" : undefined}
    />
  );
}
