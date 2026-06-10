import { useEffect } from "react";
import { useStyleguideStore } from "../stores/styleguideStore";
import { isEditableShortcutTarget } from "../utils/keyboard";
import { isStyleguideShortcut } from "../utils/styleguideShortcut";

/**
 * Toggles the hidden dev-chrome shortcuts (currently just the live-chat debug
 * button) via the global keystroke. The styleguide page it once also navigated
 * to has been removed — the canonical design now lives in docs/design — so this
 * only flips the store's chrome-visibility flags.
 */
export function StyleguideShortcut() {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!isStyleguideShortcut(event)) return;
      if (event.repeat) return;
      if (isEditableShortcutTarget(event.target)) return;

      event.preventDefault();
      const styleguideStore = useStyleguideStore.getState();
      if (styleguideStore.isLiveChatButtonVisible) {
        styleguideStore.hideChromeShortcuts();
      } else {
        styleguideStore.revealChromeShortcuts();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return null;
}
