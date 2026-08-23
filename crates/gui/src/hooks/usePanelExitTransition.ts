import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

interface PanelPresence {
  /** Render the panel node while true (stays true through the exit animation). */
  mounted: boolean;
  /** Apply the exit animation while true. */
  closing: boolean;
  /**
   * Attach to the panel root's `onAnimationEnd`. When the exit animation lands,
   * the node unmounts — so the panel stays mounted for the *full* animation
   * regardless of render/timer timing.
   */
  onAnimationEnd: (event: {
    target: EventTarget;
    currentTarget: EventTarget;
  }) => void;
}

/**
 * Defers unmount so a close animation can play. React removes a conditionally
 * rendered node synchronously, which would cut off any CSS exit keyframe — so
 * we keep `mounted` true after `open` flips false, flagging `closing`, and only
 * unmount when the exit animation actually ends (via `onAnimationEnd`). A
 * fallback timer (`durationMs` + margin) covers the cases where no animation
 * runs — `prefers-reduced-motion`, or a hidden tab — so the node can't get
 * stuck mounted. Re-opening mid-close cancels the pending unmount.
 */
export function usePanelExitTransition(
  open: boolean,
  durationMs: number
): PanelPresence {
  const [presence, setPresence] = useState<{
    mounted: boolean;
    closing: boolean;
  }>({ mounted: open, closing: false });
  const timer = useRef<number | null>(null);
  const mountedRef = useRef(presence.mounted);
  mountedRef.current = presence.mounted;
  const closingRef = useRef(presence.closing);
  closingRef.current = presence.closing;

  const clearTimer = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const finishClose = useCallback(() => {
    clearTimer();
    setPresence((p) => (p.closing ? { mounted: false, closing: false } : p));
  }, []);

  useLayoutEffect(() => {
    if (open) {
      clearTimer();
      setPresence({ mounted: true, closing: false });
      return;
    }
    // open went false — if currently shown, drill out, then unmount.
    if (!mountedRef.current) return;
    setPresence({ mounted: true, closing: true });
    clearTimer();
    // Safety net: animationend may not fire (reduced motion, off-screen). Give
    // the animation its full duration plus a margin, then force the unmount.
    timer.current = window.setTimeout(finishClose, durationMs + 80);
  }, [open, durationMs, finishClose]);

  useEffect(() => () => clearTimer(), []);

  const onAnimationEnd = useCallback(
    (event: { target: EventTarget; currentTarget: EventTarget }) => {
      // Only the panel root's own exit animation should trigger unmount — not a
      // child's animation bubbling up.
      if (event.target === event.currentTarget && closingRef.current) {
        finishClose();
      }
    },
    [finishClose]
  );

  return {
    mounted: presence.mounted,
    closing: presence.closing,
    onAnimationEnd,
  };
}
