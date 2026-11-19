import { useCallback, useLayoutEffect, useRef } from "react";
import { useScrollFollow } from "./useScrollFollow";

const inlineViewports = new WeakSet<HTMLElement>();

export function hasInlineScrollFollow(viewport: HTMLElement) {
  return inlineViewports.has(viewport);
}

export function useInlineScrollFollow(turnId: string | undefined) {
  const cardRef = useRef<HTMLElement>(null);
  const viewportRef = useRef<HTMLElement>(null);

  const targetTop = useCallback((viewport: HTMLElement) => {
    const card = cardRef.current;
    if (!card || viewport.clientHeight === 0) return viewport.scrollTop;

    const cardBottom = card.getBoundingClientRect().bottom;
    const viewportBottom =
      viewport.getBoundingClientRect().top +
      viewport.clientTop +
      viewport.clientHeight;
    return viewport.scrollTop + cardBottom - viewportBottom;
  }, []);

  const {
    reset,
    schedule,
    beginUserScroll,
    beginGesture,
    onKeyDown,
    onScroll,
  } = useScrollFollow(viewportRef, !!turnId, { targetTop });

  useLayoutEffect(() => {
    const card = cardRef.current;
    const viewport = card?.closest<HTMLElement>(
      ".changes-code-view, .evdiff-scroll, .document-body, [data-transcript-viewport]"
    );
    if (!card || !viewport || !turnId) return;

    viewportRef.current = viewport;
    inlineViewports.add(viewport);
    reset();

    const wheel = (event: WheelEvent) => {
      if (event.deltaY < 0) beginUserScroll();
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.target === viewport) beginGesture();
    };
    const scroll = () => onScroll(viewport);

    viewport.addEventListener("wheel", wheel, { passive: true });
    viewport.addEventListener("touchstart", beginGesture, { passive: true });
    viewport.addEventListener("pointerdown", pointerDown);
    viewport.addEventListener("keydown", onKeyDown);
    viewport.addEventListener("scroll", scroll, { passive: true });

    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    observer?.observe(card);
    observer?.observe(viewport);
    schedule();

    return () => {
      reset();
      observer?.disconnect();
      viewport.removeEventListener("wheel", wheel);
      viewport.removeEventListener("touchstart", beginGesture);
      viewport.removeEventListener("pointerdown", pointerDown);
      viewport.removeEventListener("keydown", onKeyDown);
      viewport.removeEventListener("scroll", scroll);
      inlineViewports.delete(viewport);
      viewportRef.current = null;
    };
  }, [
    turnId,
    reset,
    schedule,
    beginUserScroll,
    beginGesture,
    onKeyDown,
    onScroll,
  ]);

  return cardRef;
}
