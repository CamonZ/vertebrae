import { useEffect, useRef, useState, type HTMLAttributes } from "react";

export function sidebarBounds(container: number) {
  const max = Math.max(36, Math.min(560, container - 180));
  return { min: Math.min(180, max), max };
}

export function clampSidebar(width: number, container: number) {
  const { min, max } = sidebarBounds(container);
  return Math.min(max, Math.max(min, Number.isFinite(width) ? width : 240));
}

/** Remember the desired width across collapse and temporary window shrink. */
export function useSidebarResize() {
  const containerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const [available, setAvailable] = useState(800);
  const [preferred, setPreferred] = useState(240);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(([entry]) =>
      setAvailable(entry.contentRect.width)
    );

    observer.observe(node);

    return () => observer.disconnect();
  }, []);

  const width = clampSidebar(preferred, available);
  const { min, max } = sidebarBounds(available);
  const handleProps: HTMLAttributes<HTMLDivElement> = {
    role: "separator",
    tabIndex: 0,
    "aria-label": "Resize files sidebar",
    "aria-orientation": "vertical",
    "aria-valuenow": width,
    "aria-valuemin": min,
    "aria-valuemax": max,
    onPointerDown(event) {
      if (event.button !== 0) return;

      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, x: event.clientX, width };
    },
    onPointerMove(event) {
      const start = drag.current;

      if (start && start.id === event.pointerId)
        setPreferred(
          clampSidebar(start.width + event.clientX - start.x, available)
        );
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
              ? width - 10
              : event.key === "ArrowRight"
                ? width + 10
                : null;
      if (next == null) return;

      event.preventDefault();
      setPreferred(clampSidebar(next, available));
    },
  };

  return { containerRef, width, handleProps };
}
