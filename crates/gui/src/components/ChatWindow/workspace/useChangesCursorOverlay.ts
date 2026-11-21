import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import type { SelectedLineRange } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import type { ReviewAnnotation } from "../../thread/toolChange/DiffCommentThread";
import type { GapCursor } from "../../thread/toolChange/diffCursor";
import { GAP_CURSOR_ATTRIBUTE } from "./useChangeGaps";

type ViewRef = RefObject<CodeViewHandle<ReviewAnnotation, undefined> | null>;
type Selection = { id: string; range: SelectedLineRange } | null | undefined;

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const NUMBER = "[data-column-number]";
const LINE = "[data-line]";
const SELECTED = "[data-selected-line]";
const END = "data-changes-cursor-end";
const RANGE_FILL = "--changes-selection-fill";
const GLIDE_MS = 50;
/** Moves closer together than this (a held arrow key) jump instead of easing. */
const RAPID_MOVE_MS = 150;

function isMultiLine(range: SelectedLineRange) {
  const side = range.side ?? "additions";
  return range.start !== range.end || side !== (range.endSide ?? side);
}

/** Smooth-follow a deliberate move; jump while the arrow key repeats. */
export function changesCursorScrollBehavior(sinceLastMove: number) {
  return sinceLastMove < RAPID_MOVE_MS || matchMedia(REDUCED_MOTION).matches
    ? "instant"
    : "smooth";
}

function selectionKey(selected: Selection, gap: GapCursor | null) {
  const range = selected?.range;
  return JSON.stringify([
    selected?.id ?? gap?.path,
    range?.start,
    range?.side,
    range?.end,
    range?.endSide,
    gap?.gap,
    gap?.side,
  ]);
}

function textRange(line: HTMLElement, firstCharacter: boolean): Range | null {
  const content = line.textContent ?? "";
  const start = content.search(/\S/u);
  if (start === -1) return null;
  const end = firstCharacter
    ? start + (content.codePointAt(start)! > 0xffff ? 2 : 1)
    : content.trimEnd().length;
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = (node as Text).length;
    if (!started && start < offset + length) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset += length;
  }
  return null;
}

/** Join token fragments on each visual line, including wrapped code. */
function rangeFill(line: HTMLElement): string {
  const text = textRange(line, false);
  if (!text) return "";
  const bounds = line.getBoundingClientRect();
  const segments = new Map<
    number,
    { left: number; right: number; height: number }
  >();
  for (const { left, top, right, width, height } of text.getClientRects()) {
    if (width <= 0) continue;
    const segment = segments.get(top);
    if (segment) {
      segment.left = Math.min(segment.left, left);
      segment.right = Math.max(segment.right, right);
      segment.height = Math.max(segment.height, height);
    } else {
      segments.set(top, { left, right, height });
    }
  }
  return [...segments]
    .map(
      ([top, { left, right, height }]) =>
        `linear-gradient(var(--changes-range-tint), var(--changes-range-tint)) ${left - bounds.left}px ${top - bounds.top}px / ${right - left}px ${height}px no-repeat`
    )
    .join(", ");
}

type Marker = { x: number; y: number; height: number };

function positionMarker(
  element: HTMLElement,
  marker: Marker | null,
  glide: boolean,
  stretch: boolean
) {
  const wasVisible = !element.hidden;
  element.hidden = !marker;
  if (!marker) {
    element.getAnimations?.().forEach((animation) => animation.cancel());
    return;
  }

  const { x, y, height } = marker;
  const transform = `translate3d(${x}px, ${y}px, 0) scaleY(${height})`;
  if (wasVisible && element.style.transform === transform) return;
  const from = glide
    ? wasVisible
      ? getComputedStyle(element).transform
      : element.style.transform
    : null;
  element.getAnimations?.().forEach((animation) => animation.cancel());
  element.style.transform = transform;
  if (!from || from === "none" || !element.animate) return;

  const previous = new DOMMatrixReadOnly(from);
  const top = Math.min(y, previous.m42);
  const bottom = Math.max(y + height, previous.m42 + previous.m22);
  const frames = [{ transform: from }, { transform }];
  if (stretch) {
    frames.splice(1, 0, {
      transform: `translate3d(${(x + previous.m41) / 2}px, ${top}px, 0) scaleY(${bottom - top})`,
    });
  }
  element.animate(frames, { duration: GLIDE_MS, easing: "ease-out" });
}

/** Paint the existing selection over Pierre's mounted rows, once per frame. */
export function useChangesCursorOverlay(
  viewRef: ViewRef,
  containerRef: RefObject<HTMLDivElement | null>,
  selected: Selection,
  gap: GapCursor | null,
  /** Changes when the view's scroller is replaced, to listen on the new one. */
  generation: unknown = null
) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const paint = useRef<(repaintRange: boolean) => void>(() => undefined);
  const schedule = useCallback(() => paint.current(true), []);
  const inputs = useRef({ selected, gap });
  const paintedInputs = useRef<string | null>(null);

  // The selection object is rebuilt on every render; repaint only when it
  // actually changes. Pierre re-renders repaint through onPostRender.
  useLayoutEffect(() => {
    inputs.current = { selected, gap };
    const key = selectionKey(selected, gap);
    if (key === paintedInputs.current) return;
    paintedInputs.current = key;
    schedule();
  });

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const container = containerRef.current;
    if (!overlay || !container) return;
    const bar = overlay.children[0] as HTMLElement;
    const caret = overlay.children[1] as HTMLElement;
    const motion = matchMedia(REDUCED_MOTION);
    let frame = 0;
    let root: ShadowRoot | undefined | null;
    let lastKey: string | null = null;
    let lastMove = -Infinity;
    let markedDiff: HTMLElement | null = null;
    let markedNumber: HTMLElement | null = null;
    let observedGutter: HTMLElement | null = null;
    let highlightedLines = new Map<HTMLElement, string>();
    let repaintRange = false;
    const onScroll = () => paint.current(false);

    const draw = () => {
      frame = 0;
      const dirtyRange = repaintRange;
      repaintRange = false;
      const { selected, gap } = inputs.current;
      const range = selected?.range;
      const id = selected?.id ?? gap?.path;
      if (!id && lastKey === null && !markedDiff) return;
      const key = selectionKey(selected, gap);
      const view = viewRef.current?.getInstance();
      const rendered = view?.getRenderedItems() ?? [];
      const item =
        id === undefined ? undefined : rendered.find((item) => item.id === id);
      const nextRoot = item?.element.shadowRoot;
      if (nextRoot !== root) {
        root?.removeEventListener("scroll", onScroll, true);
        root = nextRoot;
        root?.addEventListener("scroll", onScroll, {
          capture: true,
          passive: true,
        });
      }
      const pre = range
        ? (root?.querySelector<HTMLElement>("pre[data-diff]") ?? null)
        : null;
      const viewport = container.getBoundingClientRect();
      // Markers are placed in the overlay, which may start above the
      // scroller (a status line between them).
      const origin = overlay.getBoundingClientRect();
      const scroll = container.scrollTop;
      let barPosition: Marker | null = null;
      let caretPosition: Marker | null = null;
      let number: HTMLElement | null = null;
      const multiple = !!range && isMultiLine(range);
      const selectedFill = dirtyRange ? new Map<HTMLElement, string>() : null;

      if (root && item?.type === "diff" && range) {
        const side = range.endSide ?? range.side ?? "additions";
        const column =
          root.querySelector(`[data-code][data-${side}]`) ??
          root.querySelector("[data-code][data-unified]");
        const index = item.instance.getLineIndex(range.end, side)?.join(",");
        if (column && index !== undefined) {
          number = column.querySelector<HTMLElement>(
            `${NUMBER}[data-line-index="${index}"]`
          );
          const line = column.querySelector<HTMLElement>(
            `${LINE}[data-line-index="${index}"]`
          );
          // The block caret is the line cursor's only marker; the gutter bar
          // is kept for gaps, which have no caret.
          const endpoint = number?.getBoundingClientRect();
          if (line && endpoint) {
            const lineRect = line.getBoundingClientRect();
            const character = textRange(line, true)?.getBoundingClientRect();
            const style = getComputedStyle(line);
            const height = parseFloat(style.lineHeight);
            const x =
              character?.left ?? lineRect.left + parseFloat(style.paddingLeft);
            const top = character
              ? character.top - (height - character.height) / 2
              : lineRect.top;
            if (
              x >= endpoint.right &&
              x < column.getBoundingClientRect().right
            ) {
              caretPosition = {
                x: x - origin.left,
                y: top - origin.top + scroll,
                height,
              };
              caret.style.width = character ? `${character.width}px` : "1ch";
            }
          }
        }

        if (selectedFill && multiple) {
          for (const line of root.querySelectorAll<HTMLElement>(
            `${LINE}${SELECTED}`
          )) {
            const fill = rangeFill(line);
            if (fill) selectedFill.set(line, fill);
          }
        }
      } else if (root && gap) {
        const selector = `[data-gutter] [${GAP_CURSOR_ATTRIBUTE}]`;
        const separator =
          root.querySelector<HTMLElement>(
            `[data-code][data-${gap.side}] ${selector}`
          ) ?? root.querySelector<HTMLElement>(selector);
        if (separator) {
          const rect = separator.getBoundingClientRect();
          barPosition = {
            x: rect.left - origin.left,
            y: rect.top - origin.top + scroll,
            height: rect.height,
          };
        }
      }

      // The overlay sits above Pierre's isolated stacking context. Clip it at
      // the pinned header and scrollbar, and follow scroll outside the tween.
      const first = rendered.find(
        ({ element }) => element.getBoundingClientRect().bottom > viewport.top
      );
      const heading = first?.element.shadowRoot?.querySelector(
        "[data-diffs-header]"
      );
      const headingBottom =
        heading?.getBoundingClientRect().bottom ?? viewport.top;
      const clipTop = Math.max(0, headingBottom - origin.top);
      const clipRight = Math.max(
        0,
        origin.right - (viewport.left + container.clientWidth)
      );
      overlay.style.clipPath = `inset(${clipTop}px ${clipRight}px 0 0)`;
      overlay.style.setProperty("--changes-scroll-y", `${-scroll}px`);

      if (pre !== markedDiff) {
        markedDiff?.removeAttribute("data-changes-cursor-diff");
        markedDiff = pre;
      }
      const kind = multiple ? "range" : "line";
      if (pre && pre.getAttribute("data-changes-cursor-diff") !== kind) {
        pre.setAttribute("data-changes-cursor-diff", kind);
      }
      // A reading-scale or font change can resize the gutter while the
      // viewport itself stays fixed.
      const gutter = number?.parentElement ?? null;
      if (gutter !== observedGutter) {
        if (observedGutter) resize.unobserve(observedGutter);
        if (gutter) resize.observe(gutter);
        observedGutter = gutter;
      }
      if (number !== markedNumber) {
        markedNumber?.removeAttribute(END);
        number?.setAttribute(END, "");
        markedNumber = number;
      }
      if (selectedFill) {
        for (const line of highlightedLines.keys()) {
          if (!selectedFill.has(line)) line.style.removeProperty(RANGE_FILL);
        }
        for (const [line, fill] of selectedFill) {
          if (highlightedLines.get(line) !== fill)
            line.style.setProperty(RANGE_FILL, fill);
        }
        highlightedLines = selectedFill;
      }

      const moved = lastKey !== null && key !== lastKey;
      const now = performance.now();
      const glide = moved && !motion.matches && now - lastMove >= RAPID_MOVE_MS;
      if (moved) lastMove = now;
      positionMarker(bar, barPosition, glide, true);
      positionMarker(caret, caretPosition, glide, false);
      if (barPosition || caretPosition) lastKey = key;
      if (!id) {
        lastKey = null;
        bar.style.removeProperty("transform");
        caret.style.removeProperty("transform");
      }
    };

    paint.current = (invalidateRange) => {
      repaintRange ||= invalidateRange;
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const resize = new ResizeObserver(schedule);
    const onMotionChange = () => {
      if (!motion.matches) return;
      for (const marker of [bar, caret]) {
        marker.getAnimations?.().forEach((animation) => animation.cancel());
      }
    };
    motion.addEventListener("change", onMotionChange);
    resize.observe(container);
    container.addEventListener("scroll", onScroll, { passive: true });
    schedule();
    return () => {
      paint.current = () => undefined;
      cancelAnimationFrame(frame);
      resize.disconnect();
      motion.removeEventListener("change", onMotionChange);
      container.removeEventListener("scroll", onScroll);
      root?.removeEventListener("scroll", onScroll, true);
      markedNumber?.removeAttribute(END);
      markedDiff?.removeAttribute("data-changes-cursor-diff");
      for (const line of highlightedLines.keys())
        line.style.removeProperty(RANGE_FILL);
      for (const marker of [bar, caret]) {
        positionMarker(marker, null, false, false);
      }
    };
    // `generation` re-binds to a remounted scroller.
  }, [containerRef, schedule, viewRef, generation]);

  return { overlayRef, schedule };
}

// Pierre owns the base diff and hover colors. Override only its selection
// layer so the addition/deletion styling is still visible through the tint.
export const CHANGES_CURSOR_CSS = `
[data-changes-cursor-diff="line"] {
  --changes-cursor-row-tint: var(--color-accent);
}
[data-changes-cursor-diff] [data-selected-line] {
  --diffs-hover-mix-target: var(--changes-cursor-row-tint, var(--diffs-mixer));
  --diffs-computed-selected-line-bg: color-mix(in oklab, var(--diffs-computed-diff-line-bg), var(--changes-cursor-row-tint, var(--diffs-computed-diff-line-bg)) var(--changes-row-strength, 18%));
}
[data-changes-cursor-diff] [data-line][data-selected-line] {
  background: var(--changes-selection-fill, none) var(--diffs-line-bg);
}
[data-changes-cursor-diff] [data-column-number][data-selected-line] {
  color: var(--diffs-fg-number);
  box-shadow: none;
  border-color: var(--diffs-line-bg);
}
[data-changes-cursor-diff="line"] [data-column-number][data-selected-line],
[data-changes-cursor-diff] [data-column-number][data-changes-cursor-end] {
  color: color-mix(in oklab, var(--diffs-fg-number), var(--diffs-fg) var(--changes-number-strength));
}
/* Pierre pins the comment button to the range end; keep the cursor line quiet
   until the pointer is over it. */
@media (hover: hover) and (pointer: fine) {
  [data-changes-cursor-diff] [data-column-number][data-selected-line]:not(:hover, :focus-within) [data-gutter-utility-slot] {
    opacity: 0;
    pointer-events: none;
  }
}
`;
