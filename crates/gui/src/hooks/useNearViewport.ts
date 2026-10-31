import { useLayoutEffect, useState, type RefObject } from "react";

/** How far outside its scroll container an element starts to count as near. */
export const NEAR_VIEWPORT_MARGIN_PX = 1200;
/**
 * How far it must then move away to stop counting as near. The gap keeps
 * scrolling back and forth from repeatedly toggling the same elements.
 */
export const FAR_VIEWPORT_MARGIN_PX = 3600;
/**
 * How long an element must stay within the near margin before it counts as
 * near, so a fast fling passes over elements without switching them.
 */
export const NEAR_VIEWPORT_DWELL_MS = 150;

type Listener = (isIntersecting: boolean) => void;
type RootObserver = {
  observer: IntersectionObserver;
  listeners: Map<Element, Listener>;
};

/** One observer per scroll root and margin, shared by every element. */
const observers = new Map<Element | null, Map<number, RootObserver>>();

function scrollRoot(element: Element): Element | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

function observe(
  root: Element | null,
  margin: number,
  element: Element,
  listener: Listener
): () => void {
  let byMargin = observers.get(root);
  if (!byMargin) observers.set(root, (byMargin = new Map()));
  let entry = byMargin.get(margin);
  if (!entry) {
    const listeners = new Map<Element, Listener>();
    const observer = new IntersectionObserver(
      (changes) => {
        for (const change of changes)
          listeners.get(change.target)?.(change.isIntersecting);
      },
      { root, rootMargin: `${margin}px 0px` }
    );
    byMargin.set(margin, (entry = { observer, listeners }));
  }
  const { observer, listeners } = entry;
  listeners.set(element, listener);
  observer.observe(element);
  return () => {
    observer.unobserve(element);
    listeners.delete(element);
    if (listeners.size > 0) return;
    observer.disconnect();
    byMargin.delete(margin);
    if (byMargin.size === 0) observers.delete(root);
  };
}

function isNear(element: Element, root: Element | null): boolean {
  const rect = element.getBoundingClientRect();
  const { top, bottom } = root
    ? root.getBoundingClientRect()
    : { top: 0, bottom: window.innerHeight };
  return (
    rect.bottom >= top - NEAR_VIEWPORT_MARGIN_PX &&
    rect.top <= bottom + NEAR_VIEWPORT_MARGIN_PX
  );
}

/**
 * Whether an element is near its scroll container's visible area: it becomes
 * near after staying within NEAR_VIEWPORT_MARGIN_PX for NEAR_VIEWPORT_DWELL_MS
 * and stays near until it is more than FAR_VIEWPORT_MARGIN_PX away. The
 * initial state is measured before the first paint, so elements already on
 * screen never show their far state. Without IntersectionObserver (tests,
 * older engines) every element is near.
 */
export function useNearViewport(ref: RefObject<Element | null>): boolean {
  const supported = typeof IntersectionObserver !== "undefined";
  const [near, setNear] = useState(!supported);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!supported || !element) return;
    const root = scrollRoot(element);
    setNear(isNear(element, root));
    let dwell: ReturnType<typeof setTimeout> | undefined;
    const stopNear = observe(root, NEAR_VIEWPORT_MARGIN_PX, element, (hit) => {
      clearTimeout(dwell);
      if (hit) dwell = setTimeout(() => setNear(true), NEAR_VIEWPORT_DWELL_MS);
    });
    const stopFar = observe(root, FAR_VIEWPORT_MARGIN_PX, element, (hit) => {
      if (!hit) setNear(false);
    });
    return () => {
      clearTimeout(dwell);
      stopNear();
      stopFar();
    };
  }, [ref, supported]);

  return near;
}
