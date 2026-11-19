import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import {
  caretBox,
  caretPoint,
  comparePoints,
  lastVisibleLine,
  locate,
  move,
  moveLine,
  movePage,
  type CaretPosition,
  type LineBox,
  type Motion,
} from "./transcriptLines";

/**
 * `active` while the transcript has focus; `passive` while focus is in the
 * comment card for its selection (or outside the window), so the caret stays
 * where it was; `off` otherwise.
 */
export type TranscriptCursorState = "off" | "active" | "passive";

/** Space kept between the caret and the viewport edge when following. */
const FOLLOW_MARGIN_PX = 40;
/** Surfaces that keep the caret (dimmed) while they hold focus. */
const KEEPS_CURSOR_SELECTOR =
  ".chat-comment-card, .chat-comment-trigger, [data-transcript-cursor-keep]";

/** A caret position that outlives re-renders: its item and offset in it. */
interface Caret {
  item: HTMLElement;
  index: number;
  after: boolean;
  /** Items after and including the caret's, to find it after a remount. */
  fromEnd: number;
}

function caretOf(position: CaretPosition): Caret {
  return {
    item: position.item.item,
    index: position.index,
    after: position.after,
    fromEnd: position.items.length - position.itemIndex,
  };
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function transcriptSelection(content: HTMLElement): Selection | null {
  const selection = window.getSelection();
  if (
    !selection ||
    selection.isCollapsed ||
    !selection.anchorNode ||
    !selection.focusNode ||
    !content.contains(selection.anchorNode) ||
    !content.contains(selection.focusNode)
  )
    return null;
  return selection;
}

/** The motion an arrow key makes with its modifiers (⌘ line/item, ⌥ word/paragraph). */
function motionOf(
  event: KeyboardEvent<HTMLElement>
): { motion: Motion | "line" | "page"; direction: -1 | 1 } | null {
  const { altKey: alt, metaKey: meta } = event;
  switch (event.key) {
    case "ArrowLeft":
    case "ArrowRight":
      return {
        motion: meta ? "lineboundary" : alt ? "word" : "character",
        direction: event.key === "ArrowRight" ? 1 : -1,
      };
    case "ArrowUp":
    case "ArrowDown":
      return {
        motion: meta ? "item" : alt ? "paragraph" : "line",
        direction: event.key === "ArrowDown" ? 1 : -1,
      };
    case "PageUp":
    case "PageDown":
      if (meta || alt) return null;
      return { motion: "page", direction: event.key === "PageDown" ? 1 : -1 };
    case "Home":
    case "End":
      if (meta || alt) return null;
      return { motion: "document", direction: event.key === "End" ? 1 : -1 };
    default:
      return null;
  }
}

interface UseTranscriptCursorOptions {
  viewportRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  overlayRef: RefObject<HTMLElement | null>;
  /** Leave the transcript (Esc without a selection). */
  onExit: () => void;
}

/**
 * The transcript's keyboard caret, moved like an editor's: arrows by
 * character and line, ⌥ by word and paragraph, ⌘ to line ends and between
 * items; Shift extends the DOM selection, which is the only selection model.
 * The caret lives in refs and its overlay is positioned imperatively; only
 * focus changes (`state`) re-render the owner.
 */
export function useTranscriptCursor({
  viewportRef,
  contentRef,
  overlayRef,
  onExit,
}: UseTranscriptCursorOptions) {
  const [state, setState] = useState<TranscriptCursorState>("off");
  const caretRef = useRef<Caret | null>(null);
  /** The selection's fixed end while Shift moves extend it. */
  const anchorRef = useRef<Caret | null>(null);
  /** The column vertical moves keep to, set by the first of a run. */
  const goalXRef = useRef<number | null>(null);
  const pointerRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  const current = useCallback((): CaretPosition | null => {
    const content = contentRef.current;
    const caret = caretRef.current;
    return content && caret ? locate(content, caret) : null;
  }, [contentRef]);

  /** Draw the caret overlay at `known` (or the stored caret). */
  const draw = useCallback(
    (known?: CaretPosition) => {
      const overlay = overlayRef.current;
      const viewport = viewportRef.current;
      if (!overlay || !viewport) return;
      const position = known ?? current();
      const box = position ? caretBox(position) : null;
      if (!box || stateRef.current === "off") {
        overlay.hidden = true;
        return;
      }
      const origin = viewport.getBoundingClientRect();
      overlay.hidden = false;
      overlay.dataset.state = stateRef.current;
      overlay.style.setProperty(
        "--caret-x",
        `${box.left - origin.left + viewport.scrollLeft}px`
      );
      overlay.style.setProperty(
        "--caret-y",
        `${box.top - origin.top + viewport.scrollTop}px`
      );
      overlay.style.setProperty("--caret-width", `${box.right - box.left}px`);
      overlay.style.setProperty("--caret-height", `${box.bottom - box.top}px`);
      // A moved caret shows solid, then blinks.
      overlay
        .getAnimations?.({ subtree: true })
        .forEach((animation) => (animation.currentTime = 0));
    },
    [current, overlayRef, viewportRef]
  );

  /**
   * Keep `box` inside the viewport with a margin. Jumps scroll instantly: a
   * long smooth scroll would be cut short when it loads older history.
   */
  const follow = useCallback(
    (box: LineBox | null, glide = false) => {
      const viewport = viewportRef.current;
      if (!viewport || !box) return;
      const origin = viewport.getBoundingClientRect();
      const margin = Math.min(FOLLOW_MARGIN_PX, viewport.clientHeight / 4);
      let delta = 0;
      if (box.top < origin.top + margin) delta = box.top - origin.top - margin;
      else if (box.bottom > origin.top + viewport.clientHeight - margin)
        delta = box.bottom - (origin.top + viewport.clientHeight - margin);
      if (Math.abs(delta) < 1) return;
      viewport.scrollTo({
        top: viewport.scrollTop + delta,
        behavior: glide && !prefersReducedMotion() ? "smooth" : "auto",
      });
    },
    [viewportRef]
  );

  const moveTo = useCallback(
    (position: CaretPosition, glide = false) => {
      caretRef.current = caretOf(position);
      draw(position);
      follow(caretBox(position), glide);
    },
    [draw, follow]
  );

  const clearSelection = useCallback(() => {
    anchorRef.current = null;
    const content = contentRef.current;
    if (content && transcriptSelection(content))
      window.getSelection()?.removeAllRanges();
  }, [contentRef]);

  /** Put the caret at the start of the last visible line. */
  const place = useCallback(() => {
    const content = contentRef.current;
    const viewport = viewportRef.current;
    if (!content || !viewport) return;
    anchorRef.current = null;
    goalXRef.current = null;
    const position = lastVisibleLine(content, viewport.getBoundingClientRect());
    caretRef.current = position ? caretOf(position) : null;
    if (position) moveTo(position);
    else draw();
  }, [contentRef, draw, moveTo, viewportRef]);

  const clear = useCallback(() => {
    caretRef.current = null;
    anchorRef.current = null;
    goalXRef.current = null;
    setState("off");
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>): boolean => {
      if (
        event.defaultPrevented ||
        event.nativeEvent.isComposing ||
        event.target !== event.currentTarget ||
        stateRef.current !== "active" ||
        event.ctrlKey
      )
        return false;
      const content = contentRef.current;
      const viewport = viewportRef.current;
      if (!content || !viewport) return false;

      if (event.key === "Escape") {
        if (event.shiftKey || event.altKey || event.metaKey) return false;
        event.preventDefault();
        if (transcriptSelection(content)) {
          clearSelection();
          draw();
        } else {
          onExit();
        }
        return true;
      }

      const step = motionOf(event);
      // ⌘⌥ arrows move between the pane's areas.
      if (!step || (event.metaKey && event.altKey)) return false;
      const position = current();
      // An empty transcript has no caret to move; only Esc applies.
      if (!position) return false;
      event.preventDefault();

      const vertical = step.motion === "line" || step.motion === "page";
      if (!vertical) goalXRef.current = null;
      const x = vertical
        ? (goalXRef.current ??= caretBox(position)?.left ?? 0)
        : 0;

      const selection = transcriptSelection(content);
      let target: CaretPosition;
      if (
        selection &&
        !event.shiftKey &&
        step.motion === "character" &&
        anchorRef.current
      ) {
        // An arrow collapses a selection to its end on that side.
        const anchor = locate(content, anchorRef.current);
        const anchorFirst =
          !!anchor &&
          comparePoints(caretPoint(anchor), caretPoint(position)) < 0;
        target =
          anchor && anchorFirst === (step.direction === -1) ? anchor : position;
      } else if (step.motion === "line") {
        target = moveLine(position, step.direction, x);
      } else if (step.motion === "page") {
        target = movePage(
          position,
          step.direction,
          x,
          Math.max(viewport.clientHeight - 2 * FOLLOW_MARGIN_PX, 40)
        );
      } else {
        target = move(position, step.motion, step.direction);
      }

      if (event.shiftKey) {
        if (!anchorRef.current || !selection)
          anchorRef.current = caretOf(position);
        const anchor = locate(content, anchorRef.current);
        if (anchor) {
          const base = caretPoint(anchor);
          const extent = caretPoint(target);
          window
            .getSelection()
            ?.setBaseAndExtent(
              base.node,
              base.offset,
              extent.node,
              extent.offset
            );
        }
      } else {
        clearSelection();
      }
      moveTo(target, step.motion === "line");
      return true;
    },
    [clearSelection, contentRef, current, draw, moveTo, onExit, viewportRef]
  );

  const onFocus = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return;
      if (pointerRef.current) {
        pointerRef.current = false;
        return;
      }
      const resume = !!current();
      stateRef.current = "active";
      setState("active");
      if (!resume) place();
      requestAnimationFrame(() => {
        if (stateRef.current !== "active") return;
        const position = current();
        draw(position ?? undefined);
        if (position) follow(caretBox(position));
      });
    },
    [current, draw, follow, place]
  );

  const onBlur = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return;
      const next = event.relatedTarget;
      const keep =
        next === null
          ? document.hasFocus() === false
          : next instanceof Element && !!next.closest(KEEPS_CURSOR_SELECTOR);
      if (keep && caretRef.current) setState("passive");
      else clear();
    },
    [clear]
  );

  /** A pointer press hands the transcript back to the mouse. */
  const onPointerDown = useCallback(() => {
    pointerRef.current = true;
    if (caretRef.current || stateRef.current !== "off") clear();
    // Focus may not follow (the press can land on a focusable child).
    setTimeout(() => {
      pointerRef.current = false;
    }, 0);
  }, [clear]);

  /** Focus the transcript, keeping the caret where it was. */
  const resume = useCallback(() => {
    viewportRef.current?.focus({ preventScroll: true });
  }, [viewportRef]);

  // Redraw as the content reflows (streaming, history, resizes).
  useEffect(() => {
    if (state === "off") {
      draw();
      return;
    }
    const content = contentRef.current;
    const viewport = viewportRef.current;
    let frame = 0;
    const redraw = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => draw());
    };
    redraw();
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(redraw) : null;
    if (content) observer?.observe(content);
    if (viewport) observer?.observe(viewport);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [contentRef, draw, state, viewportRef]);

  return {
    state,
    onKeyDown,
    onFocus,
    onBlur,
    onPointerDown,
    resume,
    clear,
  };
}
