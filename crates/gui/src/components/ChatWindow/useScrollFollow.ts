import { useCallback, useEffect, useRef, type RefObject } from "react";

const TOLERANCE_PX = 24;
// Stay inside WebKit's signed scroll range.
const BOTTOM_PX = 1_000_000_000;

export function useScrollFollow(
  viewportRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  {
    targetTop = viewportBottom,
    blocked = never,
  }: {
    targetTop?: (viewport: HTMLElement) => number;
    blocked?: (viewport: HTMLElement) => boolean;
  } = {}
) {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const following = useRef(true);
  const lastTop = useRef<number | null>(null);
  const userScroll = useRef(false);
  const gesture = useRef(false);

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const schedule = useCallback(() => {
    if (
      !enabledRef.current ||
      document.hidden ||
      !following.current ||
      timer.current !== null
    )
      return;

    timer.current = setTimeout(() => {
      timer.current = null;
      const viewport = viewportRef.current;
      if (
        !viewport ||
        !enabledRef.current ||
        document.hidden ||
        !following.current ||
        gesture.current ||
        blocked(viewport)
      )
        return;

      viewport.scrollTop = targetTop(viewport);
      lastTop.current = viewport.scrollTop;
      userScroll.current = false;
    }, 32);
  }, [viewportRef, targetTop, blocked]);

  const beginUserScroll = useCallback(() => {
    userScroll.current = true;
    cancel();
  }, [cancel]);

  const beginGesture = useCallback(() => {
    gesture.current = true;
    beginUserScroll();
  }, [beginUserScroll]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("input, textarea, [contenteditable=true]")
      )
        return;

      if (
        ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
        (event.key === " " && event.shiftKey)
      )
        beginUserScroll();
    },
    [beginUserScroll]
  );

  const nearTarget = useCallback(
    (viewport: HTMLElement, top: number, max: number) =>
      Math.abs(Math.max(0, Math.min(targetTop(viewport), max)) - top) <=
      TOLERANCE_PX,
    [targetTop]
  );

  const onScroll = useCallback(
    (viewport: HTMLElement) => {
      // Ignore elastic overscroll and clamp the old position after viewport shrink.
      const max = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      const top = Math.max(0, Math.min(viewport.scrollTop, max));
      const previous =
        lastTop.current === null ? null : Math.min(lastTop.current, max);
      const movedUp = previous === null || top < previous;
      const near = nearTarget(viewport, top, max);

      if (near && (following.current || previous === null || top > previous)) {
        following.current = true;
        if (!gesture.current) userScroll.current = false;
        schedule();
      } else if (!near && userScroll.current && movedUp) {
        following.current = false;
        cancel();
      }

      lastTop.current = top;
      return { top, movedUp };
    },
    [cancel, nearTarget, schedule]
  );

  const reset = useCallback(() => {
    cancel();
    following.current = true;
    userScroll.current = false;
    gesture.current = false;
    lastTop.current = viewportRef.current?.scrollTop ?? null;
  }, [cancel, viewportRef]);

  useEffect(() => {
    if (!enabled) cancel();
  }, [enabled, cancel]);

  useEffect(() => {
    const endGesture = () => {
      if (!gesture.current) return;
      gesture.current = false;

      const viewport = viewportRef.current;
      if (
        viewport &&
        nearTarget(
          viewport,
          viewport.scrollTop,
          viewport.scrollHeight - viewport.clientHeight
        )
      ) {
        userScroll.current = false;
      }
      schedule();
    };

    const events = ["pointerup", "pointercancel", "touchend", "touchcancel"];
    for (const event of events) document.addEventListener(event, endGesture);
    document.addEventListener("visibilitychange", schedule);

    return () => {
      for (const event of events)
        document.removeEventListener(event, endGesture);
      document.removeEventListener("visibilitychange", schedule);
      cancel();
    };
  }, [viewportRef, nearTarget, schedule, cancel]);

  return {
    schedule,
    reset,
    following,
    lastTop,
    beginUserScroll,
    beginGesture,
    onKeyDown,
    onScroll,
  };
}

function viewportBottom() {
  return BOTTOM_PX;
}

function never() {
  return false;
}
