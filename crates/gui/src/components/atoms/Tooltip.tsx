import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

export type TooltipPlacement = "top" | "bottom" | "left" | "right";

interface TooltipProps {
  label: ReactNode;
  placement?: TooltipPlacement;
  /** Delay before the tooltip appears on hover, in ms. */
  delay?: number;
  /** Disable the tooltip entirely (e.g., when label is empty in a dynamic context). */
  disabled?: boolean;
  children: ReactElement;
}

const placementClasses: Record<TooltipPlacement, string> = {
  top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
  bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
  left: "right-full top-1/2 -translate-y-1/2 mr-2",
  right: "left-full top-1/2 -translate-y-1/2 ml-2",
};

/**
 * Floating label that appears on hover/focus of its child. Hover delay matches
 * the 400ms convention from the design spec.
 */
export function Tooltip({
  label,
  placement = "top",
  delay = 400,
  disabled,
  children,
}: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function show() {
    if (disabled) return;
    timer.current = setTimeout(() => setOpen(true), delay);
  }

  function hide() {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  }

  if (!isValidElement(children)) return children;

  const childProps = (children as ReactElement).props as Record<string, unknown>;
  const child = cloneElement(children as ReactElement, {
    onMouseEnter: (e: unknown) => {
      show();
      const handler = childProps.onMouseEnter as ((e: unknown) => void) | undefined;
      handler?.(e);
    },
    onMouseLeave: (e: unknown) => {
      hide();
      const handler = childProps.onMouseLeave as ((e: unknown) => void) | undefined;
      handler?.(e);
    },
    onFocus: (e: unknown) => {
      setOpen(!disabled);
      const handler = childProps.onFocus as ((e: unknown) => void) | undefined;
      handler?.(e);
    },
    onBlur: (e: unknown) => {
      hide();
      const handler = childProps.onBlur as ((e: unknown) => void) | undefined;
      handler?.(e);
    },
    "aria-describedby": open ? id : undefined,
  } as Record<string, unknown>);

  if (disabled || !label) return child;

  return (
    <span className="relative inline-flex">
      {child}
      <span
        role="tooltip"
        id={id}
        aria-hidden={!open}
        className={[
          "pointer-events-none absolute z-50 max-w-[220px] whitespace-nowrap",
          "px-2 py-1 font-sans text-xs leading-tight",
          "bg-[var(--color-bg-3)] text-[var(--color-fg)] border border-[var(--color-line-strong)]",
          "rounded-[var(--radius-sm)] shadow-[var(--shadow-2)]",
          "transition-opacity duration-[var(--t-fast)] ease-[var(--ease-default)]",
          open ? "opacity-100" : "opacity-0",
          placementClasses[placement],
        ].join(" ")}
      >
        {label}
      </span>
    </span>
  );
}
