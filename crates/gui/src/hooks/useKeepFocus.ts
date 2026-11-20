import { useEffect, useLayoutEffect, type RefObject } from "react";
import { focusPaneComposer } from "../components/ChatWindow/chatAreas";
import {
  retainUserFocusIntent,
  userMovedFocusRecently,
} from "../utils/userFocusIntent";

type TextInput = HTMLTextAreaElement | HTMLInputElement;

function nothingFocused(): boolean {
  const active = document.activeElement;
  return !active || active === document.body;
}

/**
 * Keeps a text input focused while the user types into it.
 *
 * - When it loses focus to nothing (no other element took it) without a user
 *   action, and it is still in the document, it takes focus back with its
 *   selection. Diff annotations lose focus this way, often silently, when the
 *   diff re-renders the shadow-root slot they are projected into.
 * - When it unmounts while focused and nothing else takes focus, focus goes to
 *   the pane's composer rather than the document body.
 *
 * Focus moves to another element, or after a pointer press, Tab, Escape or a
 * shortcut, are never undone.
 */
export function useKeepFocus(ref: RefObject<TextInput | null>): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const release = retainUserFocusIntent();
    // Whether focus belongs here: set on focus, cleared by a deliberate move.
    let held = document.activeElement === element;
    let frame = 0;

    const scheduleRestore = () => {
      // The input keeps its selection while unfocused; read it before focusing.
      const { selectionStart, selectionEnd, selectionDirection } = element;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (document.activeElement === element || !document.hasFocus()) return;
        if (!element.isConnected || !nothingFocused() || userMovedFocusRecently()) {
          held = false;
          return;
        }
        element.focus({ preventScroll: true });
        if (selectionStart !== null && selectionEnd !== null)
          element.setSelectionRange(
            selectionStart,
            selectionEnd,
            selectionDirection ?? undefined
          );
      });
    };

    const onFocusIn = () => {
      held = true;
    };
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget || userMovedFocusRecently()) {
        held = false;
        return;
      }
      scheduleRestore();
    };

    // Re-rendering a shadow tree the input is slotted into (diff annotations)
    // can drop its focus without any focusout event.
    const observer = new MutationObserver(() => {
      if (held && document.activeElement !== element) scheduleRestore();
    });
    for (let node = element.parentElement; node; node = node.parentElement)
      if (node.shadowRoot)
        observer.observe(node.shadowRoot, { childList: true, subtree: true });

    const target: HTMLElement = element;
    target.addEventListener("focusin", onFocusIn);
    target.addEventListener("focusout", onFocusOut);
    return () => {
      observer.disconnect();
      target.removeEventListener("focusin", onFocusIn);
      target.removeEventListener("focusout", onFocusOut);
      cancelAnimationFrame(frame);
      release();
    };
  }, [ref]);

  // Layout cleanup runs before React detaches the element, so it can still
  // tell whether the input held focus.
  useLayoutEffect(() => {
    const element = ref.current;
    return () => {
      if (!element || document.activeElement !== element) return;
      const pane = element.closest("[data-pane-id]");
      requestAnimationFrame(() => {
        if (!pane?.isConnected || !nothingFocused()) return;
        focusPaneComposer(pane);
      });
    };
  }, [ref]);
}
