import { useEffect, useState, type RefObject } from "react";
import { ASSISTANT_RESPONSE_SELECTOR } from "./assistantTextComments";
import { quoteRects } from "./useCommentHover";

interface Geometry {
  top: number;
  height: number;
  /** The first quoted line's height, to centre the marker on it. */
  lineHeight: number;
  /** The quoted response's left rail, in viewport content coordinates. */
  rail: number;
}

/** Where a quote sits in the viewport's scrolled content. */
function geometryOf(viewport: HTMLElement, range: Range): Geometry | null {
  const rects = quoteRects(range)
    .filter((rect) => rect.height > 0)
    .sort((a, b) => a.top - b.top);
  if (!rects.length) return null;
  const frame = viewport.getBoundingClientRect();
  const start =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const response = start?.closest(ASSISTANT_RESPONSE_SELECTOR);
  const left = response?.getBoundingClientRect().left ?? rects[0].left;
  const top = rects[0].top;
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return {
    top: top - frame.top + viewport.scrollTop,
    height: bottom - top,
    lineHeight: rects[0].height,
    rail: left - frame.left + viewport.scrollLeft,
  };
}

/**
 * Rail marks for transcript comment highlights: the focused (chip-hovered
 * or pinned) quote lights the response's left rail in the accent, and the
 * quote under the pointer gets a small numbered marker on the rail that
 * opens its comment. Both sit on the rail left of the text, so neither
 * covers what is being read.
 */
export function CommentHighlightMarkers({
  viewportRef,
  rangesRef,
  hoveredId,
  activeId,
  numbers,
  revision,
  onOpen,
}: {
  viewportRef: RefObject<HTMLElement | null>;
  rangesRef: RefObject<ReadonlyMap<string, Range>>;
  hoveredId: string | null;
  activeId: string | null;
  /** Each comment's number, as on its composer chip. */
  numbers: ReadonlyMap<string, number>;
  /** Re-measure when the rendered transcript changes. */
  revision: unknown;
  onOpen(id: string): void;
}) {
  const [layout, setLayout] = useState<{
    active: Geometry | null;
    hovered: Geometry | null;
  }>({ active: null, hovered: null });

  // Measured a frame later: the parent resolves the ranges in its own
  // effect, which runs after this child's.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => {
      const geometry = (id: string | null) => {
        const range = id ? rangesRef.current.get(id) : undefined;
        return range ? geometryOf(viewport, range) : null;
      };
      setLayout({ active: geometry(activeId), hovered: geometry(hoveredId) });
    };
    let frame = requestAnimationFrame(measure);
    if (!activeId && !hoveredId) return () => cancelAnimationFrame(frame);
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(viewport);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [viewportRef, rangesRef, activeId, hoveredId, revision]);

  const { active, hovered } = layout;
  const number = hoveredId ? numbers.get(hoveredId) : undefined;
  return (
    <>
      {active ? (
        <div
          className="comment-focus-bar"
          aria-hidden="true"
          data-testid="comment-focus-bar"
          style={{ top: active.top, height: active.height, left: active.rail }}
        />
      ) : null}
      {hovered && hoveredId && number !== undefined ? (
        <button
          type="button"
          className="comment-hover-marker"
          data-comment-marker={hoveredId}
          data-testid="comment-hover-marker"
          // Pointer-only: the composer chips carry the same action for keys.
          tabIndex={-1}
          aria-label={`Open comment ${number}`}
          title={`Comment ${number} · click to open`}
          style={{
            top: hovered.top + hovered.lineHeight / 2,
            left: hovered.rail,
          }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onOpen(hoveredId)}
        >
          <span className="comment-hover-marker-number" aria-hidden="true">
            {number}
          </span>
          <svg
            className="comment-hover-marker-open"
            aria-hidden="true"
            width="9"
            height="9"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M7 17 17 7M9 7h8v8" />
          </svg>
        </button>
      ) : null}
    </>
  );
}
