import { useCallback, useEffect, useRef } from "react";
import { usePanelFocusStore } from "../stores/panelFocusStore";

interface UseGlassPanelOptions {
  /** Stable identifier for this panel (e.g. "chat", "task-detail"). */
  id: string;
  /** Whether the panel is currently shown. Registration follows this. */
  isOpen: boolean;
  /** Close the panel. Invoked when Escape lands on the focused panel. */
  onClose: () => void;
  /**
   * Return `false` to decline an Escape (e.g. while an inline edit is open, so
   * its own Escape-to-cancel wins instead of closing the whole panel).
   * Defaults to always handling Escape.
   */
  shouldHandleEscape?: () => boolean;
}

interface UseGlassPanelResult {
  /** True when this is the focused (topmost) open panel. */
  isFocused: boolean;
  /** Spread onto the panel root so interacting with it makes it focused. */
  focusProps: {
    onMouseDownCapture: () => void;
    onFocusCapture: () => void;
  };
}

/**
 * Wire a floating glass panel into the shared focus model so a single Escape
 * closes whichever panel the user is working in. The focused panel is the most
 * recently opened or clicked; only it arms an Escape handler, so the keypress
 * never crosses over to a different open panel.
 *
 * Registration is tied to `isOpen` AND component lifetime: the cleanup runs on
 * close and on unmount, which is how page-local panels get pruned when their
 * screen navigates away.
 */
export function useGlassPanel({
  id,
  isOpen,
  onClose,
  shouldHandleEscape,
}: UseGlassPanelOptions): UseGlassPanelResult {
  const open = usePanelFocusStore((s) => s.open);
  const close = usePanelFocusStore((s) => s.close);
  const focus = usePanelFocusStore((s) => s.focus);
  const isFocused = usePanelFocusStore(
    (s) => s.stack[s.stack.length - 1] === id
  );

  // Keep the latest callbacks without re-subscribing the Escape listener.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const guardRef = useRef(shouldHandleEscape);
  guardRef.current = shouldHandleEscape;

  useEffect(() => {
    if (!isOpen) return;
    open(id);
    return () => close(id);
  }, [id, isOpen, open, close]);

  useEffect(() => {
    if (!isOpen || !isFocused) return;
    // Capture phase: we run before a panel-internal handler (e.g. inline-edit
    // Escape-to-cancel) clears its own state, so our guard can read it.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // A modal/dialog owns Escape while it is up.
      if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return;
      if (guardRef.current && guardRef.current() === false) return;
      event.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [id, isOpen, isFocused]);

  const focusThis = useCallback(() => focus(id), [focus, id]);

  return {
    isFocused,
    focusProps: {
      onMouseDownCapture: focusThis,
      onFocusCapture: focusThis,
    },
  };
}
