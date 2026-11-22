import { useEffect, useState, type RefObject } from "react";
import { ASSISTANT_RESPONSE_SELECTOR } from "./assistantTextComments";

/** Pointer slack around a highlighted line, in CSS pixels. */
const HIT_SLOP = 2;
/** How far left of the rail the marker reaches, in CSS pixels. */
const MARKER_REACH = 10;

/**
 * A quote's line boxes; none where layout is unavailable (jsdom has no
 * Range.getClientRects).
 */
export function quoteRects(range: Range): DOMRect[] {
  return typeof range.getClientRects === "function"
    ? [...range.getClientRects()]
    : [];
}

/** Which comment's quote is under the point, if any. */
function commentAt(
  ranges: ReadonlyMap<string, Range>,
  x: number,
  y: number
): string | null {
  for (const [id, range] of ranges) {
    for (const rect of quoteRects(range)) {
      if (
        x >= rect.left - HIT_SLOP &&
        x <= rect.right + HIT_SLOP &&
        y >= rect.top &&
        y <= rect.bottom
      )
        return id;
    }
  }
  return null;
}

/** The quoted response's left edge: where its rail and marker sit. */
function railOf(range: Range): number | null {
  const start =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const response = start?.closest(ASSISTANT_RESPONSE_SELECTOR);
  return response ? response.getBoundingClientRect().left : null;
}

/**
 * Whether the point is on one of the quote's lines, between the rail and
 * the quote: the path from a quote to its marker.
 */
function inCorridor(range: Range, x: number, y: number): boolean {
  const rail = railOf(range);
  if (rail === null) return false;
  for (const rect of quoteRects(range)) {
    if (
      y >= rect.top &&
      y <= rect.bottom &&
      x >= rail - MARKER_REACH &&
      x <= rect.right + HIT_SLOP
    )
      return true;
  }
  return false;
}

/**
 * The comment whose highlighted quote the pointer is over. Moving onto the
 * comment's marker, or along the quoted lines toward it, keeps it hovered,
 * so the marker can be reached and clicked.
 */
export function useCommentHover(
  viewportRef: RefObject<HTMLElement | null>,
  rangesRef: RefObject<ReadonlyMap<string, Range>>,
  enabled: boolean
): string | null {
  const [hovered, setHovered] = useState<string | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !enabled) {
      setHovered(null);
      return;
    }
    let frame = 0;
    let current: string | null = null;
    let point: { x: number; y: number; target: EventTarget | null } | null =
      null;
    const update = () => {
      frame = 0;
      if (!point) return;
      const marker =
        point.target instanceof Element
          ? point.target.closest<HTMLElement>("[data-comment-marker]")
          : null;
      const ranges = rangesRef.current;
      const kept = current ? ranges.get(current) : undefined;
      const next = marker
        ? (marker.dataset.commentMarker ?? null)
        : (commentAt(ranges, point.x, point.y) ??
          (kept && inCorridor(kept, point.x, point.y) ? current : null));
      current = next;
      setHovered(next);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      point = { x: event.clientX, y: event.clientY, target: event.target };
      if (!frame) frame = requestAnimationFrame(update);
    };
    const leave = () => {
      point = null;
      cancelAnimationFrame(frame);
      frame = 0;
      current = null;
      setHovered(null);
    };
    viewport.addEventListener("pointermove", move, { passive: true });
    viewport.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("pointermove", move);
      viewport.removeEventListener("pointerleave", leave);
    };
  }, [viewportRef, rangesRef, enabled]);

  return hovered;
}
