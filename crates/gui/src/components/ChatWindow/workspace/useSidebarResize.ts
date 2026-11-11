import { useCallback, useRef, useState, type HTMLAttributes } from "react";

const CHANGES_SPLITTER_WIDTH = 2;

export function sidebarBounds(container: number) {
  const max = Math.max(36, Math.min(560, container - 180));
  return { min: Math.min(180, max), max };
}

export function clampSidebar(width: number, container: number) {
  const { min, max } = sidebarBounds(container);
  return Math.min(max, Math.max(min, Number.isFinite(width) ? width : 240));
}

/** Remember the desired width across collapse and temporary window shrink. */
export function useSidebarResize(
  options: { initial?: number; side?: "left" | "right"; label?: string } = {}
) {
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const [available, setAvailable] = useState(800);
  const [preferred, setPreferred] = useState(options.initial ?? 240);

  // The keyed discussion provider can replace the container without remounting
  // this hook. Own observation through the DOM ref, rather than a mount effect.
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;

    setAvailable(node.getBoundingClientRect().width);
    let active = true;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(([entry]) => {
            if (active && entry) setAvailable(entry.contentRect.width);
          });
    observer?.observe(node);

    return () => {
      active = false;
      observer?.disconnect();
      drag.current = null;
    };
  }, []);

  // Keep only a small usable minimum; the splitter can use the full available width.
  const { min, max } =
    options.side === "right"
      ? {
          min: 180,
          max: Math.max(180, available - 180 - CHANGES_SPLITTER_WIDTH),
        }
      : sidebarBounds(available);
  const clamp = (value: number) => Math.min(max, Math.max(min, value));
  const width = clamp(preferred);
  const handleProps: HTMLAttributes<HTMLDivElement> = {
    role: "separator",
    tabIndex: 0,
    "aria-label": options.label ?? "Resize files sidebar",
    "aria-orientation": "vertical",
    "aria-valuenow": width,
    "aria-valuemin": min,
    "aria-valuemax": max,
    onPointerDown(event) {
      if (event.button !== 0) return;

      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, x: event.clientX, width };
    },
    onPointerMove(event) {
      const start = drag.current;

      if (!start || start.id !== event.pointerId) return;

      const direction = options.side === "right" ? -1 : 1;
      const delta = (event.clientX - start.x) * direction;
      const nextWidth = clamp(start.width + delta);

      setPreferred(nextWidth);
    },
    onPointerUp(event) {
      if (!drag.current || drag.current.id !== event.pointerId) return;

      drag.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onLostPointerCapture() {
      drag.current = null;
    },
    onPointerCancel() {
      drag.current = null;
    },
    onKeyDown(event) {
      const next =
        event.key === "Home"
          ? min
          : event.key === "End"
            ? max
            : event.key === "ArrowLeft"
              ? width - 10 * (options.side === "right" ? -1 : 1)
              : event.key === "ArrowRight"
                ? width + 10 * (options.side === "right" ? -1 : 1)
                : null;
      if (next == null) return;

      event.preventDefault();

      const nextWidth = clamp(next);
      setPreferred(nextWidth);
    },
  };

  return { containerRef, width, handleProps };
}
