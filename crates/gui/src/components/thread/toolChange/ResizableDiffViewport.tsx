import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { useNearViewport } from "../../../hooks/useNearViewport";

export const DEFAULT_DIFF_HEIGHT = 360;
export const MIN_DIFF_HEIGHT = 96;
export const MAX_DIFF_HEIGHT = 2400;
const KEY_STEP = 24;

const clamp = (value: number) =>
  Math.min(MAX_DIFF_HEIGHT, Math.max(MIN_DIFF_HEIGHT, Math.round(value)));

/**
 * Scrollable inline diff container with a bottom drag handle. The height is a
 * ceiling, so short diffs stay content-sized while long ones scroll inside.
 *
 * With a `placeholder`, the children only render while the viewport is near
 * the visible area; elsewhere the cheap placeholder stands in. Once the
 * children have rendered, the placeholder keeps their last height so content
 * around it does not shift when a diff leaves the visible area.
 */
export function ResizableDiffViewport({
  children,
  placeholder,
}: {
  children: ReactNode;
  /** Receives the current height ceiling so it lays out no more than fits. */
  placeholder?: (limit: number) => ReactNode;
}): ReactNode {
  const [limit, setLimit] = useState(DEFAULT_DIFF_HEIGHT);
  const [resizing, setResizing] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; base: number } | null>(null);
  const near = useNearViewport(viewportRef);
  const gated = placeholder !== undefined && !near;
  const [renderedHeight, setRenderedHeight] = useState<number>();

  useEffect(() => {
    const viewport = viewportRef.current;
    if (gated || !viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() =>
      setRenderedHeight(viewport.getBoundingClientRect().height)
    );
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [gated]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const rendered = viewportRef.current?.getBoundingClientRect().height;
    drag.current = { startY: event.clientY, base: rendered || limit };
    setResizing(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setLimit(clamp(drag.current.base + event.clientY - drag.current.startY));
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setResizing(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta =
      event.key === "ArrowDown"
        ? KEY_STEP
        : event.key === "ArrowUp"
          ? -KEY_STEP
          : null;
    if (delta == null) return;
    event.preventDefault();
    setLimit((value) => clamp(value + delta));
  };

  return (
    <div className="evdiff">
      <div
        ref={viewportRef}
        className="evdiff-scroll"
        data-testid="diff-viewport"
        style={{
          maxHeight: limit,
          ...(gated && renderedHeight ? { height: renderedHeight } : {}),
        }}
      >
        {gated ? placeholder(limit) : children}
      </div>
      <div
        className="evdiff-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize diff"
        aria-valuenow={limit}
        aria-valuemin={MIN_DIFF_HEIGHT}
        aria-valuemax={MAX_DIFF_HEIGHT}
        tabIndex={0}
        title="Drag to resize"
        {...(resizing ? { "data-resizing": "" } : {})}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
