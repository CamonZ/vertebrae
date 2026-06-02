import { useCallback, useEffect } from "react";
import { useChatStore } from "../../stores/chatStore";
import { useOpenChat } from "../../hooks/useScopedChat";

/** Max gap (ms) between the two Alt taps that toggle the chat. */
const DOUBLE_TAP_MS = 400;

/**
 * Floating launcher pill for the project chat, adapted from the design
 * reference (docs/design/lib/lib-chat.jsx `.hc-launch`). Floats bottom-left,
 * clear of the nav rail, and is shown only while the chat panel is closed —
 * clicking it (or double-tapping Alt) opens the claude-binary project chat
 * (chatStore) in the floating-glass panel (ChatWindowManager).
 *
 * The pill itself carries no label; it shows a keyboard hint (⌥ ⌥) the way the
 * search box shows `/`. The Alt-Alt listener lives here rather than in the pill
 * markup so it stays armed even while the panel is open (this component is
 * always mounted by AppShell and only its render returns null) — making the
 * shortcut a true open/close toggle.
 */
export function FloatingChatLauncher() {
  const openChat = useOpenChat();
  const togglePanel = useChatStore((s) => s.togglePanel);
  const panelOpen = useChatStore((s) => s.panelOpen);

  // Open (and ensure a session) when closed; close when already open. Reads
  // panelOpen from the store at call time so it works from the key handler too.
  const toggleChat = useCallback(() => {
    if (useChatStore.getState().panelOpen) {
      togglePanel();
    } else {
      openChat("project", null, "Project Chat");
    }
  }, [openChat, togglePanel]);

  // Double-tap Alt to toggle. Ignore auto-repeat from a held key; use the
  // event's monotonic timeStamp to measure the gap between discrete presses.
  useEffect(() => {
    let lastAlt: number | null = null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Alt" || event.repeat) return;
      if (lastAlt !== null && event.timeStamp - lastAlt < DOUBLE_TAP_MS) {
        lastAlt = null;
        toggleChat();
      } else {
        lastAlt = event.timeStamp;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleChat]);

  // While the panel is open it owns the bottom-left anchor; hide the pill.
  if (panelOpen) return null;

  return (
    <button
      type="button"
      className="hc-launch"
      onClick={toggleChat}
      title="Open project chat (⌥ ⌥)"
      aria-label="Open project chat"
    >
      <span className="ic" aria-hidden>
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </span>
      <span className="hint" aria-hidden>
        <kbd className="key">⌥</kbd>
        <kbd className="key">⌥</kbd>
      </span>
      <span className="ember" aria-hidden />
    </button>
  );
}
