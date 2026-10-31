import { createPortal } from "react-dom";
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
  /** Escape scroll containers for compact history entries. */
  portal?: boolean;
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
  portal = false,
  placement = "top",
  delay = 400,
  disabled,
  children,
}: TooltipProps) {
  const id = useId();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  useEffect(() => {
    if (!portal || !open) return;
    const dismiss = () => setOpen(false);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [portal, open]);

  function show() {
    if (disabled) return;
    timer.current = setTimeout(() => setOpen(true), delay);
  }

  function hide() {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  }

  if (!isValidElement(children)) return children;

  const childProps = (children as ReactElement).props as Record<
    string,
    unknown
  >;
  const child = cloneElement(
    children as ReactElement,
    {
      onMouseEnter: (e: unknown) => {
        if (portal)
          setAnchor(
            (
              e as React.MouseEvent<HTMLElement>
            ).currentTarget.getBoundingClientRect()
          );
        show();
        const handler = childProps.onMouseEnter as
          | ((e: unknown) => void)
          | undefined;
        handler?.(e);
      },
      onMouseLeave: (e: unknown) => {
        hide();
        const handler = childProps.onMouseLeave as
          | ((e: unknown) => void)
          | undefined;
        handler?.(e);
      },
      onFocus: (e: unknown) => {
        if (portal)
          setAnchor(
            (
              e as React.FocusEvent<HTMLElement>
            ).currentTarget.getBoundingClientRect()
          );
        setOpen(!disabled);
        const handler = childProps.onFocus as
          | ((e: unknown) => void)
          | undefined;
        handler?.(e);
      },
      onBlur: (e: unknown) => {
        hide();
        const handler = childProps.onBlur as ((e: unknown) => void) | undefined;
        handler?.(e);
      },
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === "Escape") hide();
        const handler = childProps.onKeyDown as
          | ((e: React.KeyboardEvent) => void)
          | undefined;
        handler?.(e);
      },
      "aria-describedby": open ? id : undefined,
    } as Record<string, unknown>
  );

  if (disabled || !label) return child;

  const tooltip = (
    <span
      role="tooltip"
      id={id}
      aria-hidden={!open}
      style={
        portal && anchor
          ? {
              position: "fixed",
              left: Math.max(
                8,
                Math.min(anchor.right + 8, window.innerWidth - 236)
              ),
              top: Math.max(8, Math.min(anchor.top, window.innerHeight - 160)),
            }
          : undefined
      }
      className={[
        "pointer-events-none max-w-[220px] whitespace-nowrap",
        // Portal tooltips must clear the fixed chat surface (z-index: 70).
        portal ? "z-[100]" : "z-50",
        "px-2 py-1 font-sans text-xs leading-tight",
        "bg-[var(--color-bg-3)] text-[var(--color-fg)] border border-[var(--color-line-strong)]",
        "rounded-[var(--radius-sm)] shadow-[var(--shadow-2)]",
        "transition-opacity duration-[var(--t-fast)] ease-[var(--ease-default)]",
        open ? "opacity-100" : "opacity-0",
        portal ? "" : `absolute ${placementClasses[placement]}`,
      ].join(" ")}
    >
      {label}
    </span>
  );
  return (
    <span className="relative inline-flex">
      {child}
      {portal ? open && createPortal(tooltip, document.body) : tooltip}
    </span>
  );
}
