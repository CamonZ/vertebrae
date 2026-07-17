import { useCallback, useEffect } from "react";
import { commands } from "../../bindings";
import { useChatStore } from "../../stores/chatStore";
import { useOpenChat } from "../../hooks/useLocalChat";
import {
  compareLocalChatSessionRecency,
  projectPathMatches,
} from "../../utils/localChatPersistence";

/** Max gap (ms) between the two Alt taps that toggle the chat. */
const DOUBLE_TAP_MS = 400;

async function loadCurrentProjectPath(): Promise<string | null> {
  try {
    const result = await commands.getCurrentProjectPath();
    return result.status === "ok" && result.data ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Floating launcher pill for the project chat, adapted from the design
 * reference (docs/design/lib/lib-chat.jsx `.hc-launch`). Floats bottom-right
 * at the same edge as chat, and is shown only while the panel is closed —
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
  const setPanelOpen = useChatStore((s) => s.setPanelOpen);
  const focusSession = useChatStore((s) => s.focusSession);
  const panelOpen = useChatStore((s) => s.panelOpen);

  // Open (and ensure a session) when closed; close when already open. Reads
  // panelOpen from the store at call time so it works from the key handler too.
  const toggleChat = useCallback(async () => {
    if (useChatStore.getState().panelOpen) {
      togglePanel();
      return;
    }

    const projectPath = await loadCurrentProjectPath();
    const state = useChatStore.getState();
    if (state.panelOpen) return;

    const isReusableSession = (
      session: (typeof state.sessions)[string]
    ): boolean =>
      session.status === "open" &&
      session.lifecycle !== "closed" &&
      !session.isDetached &&
      projectPathMatches(session.projectPath, projectPath);
    const activeSession = state.activeSessionId
      ? state.sessions[state.activeSessionId]
      : null;

    if (activeSession && isReusableSession(activeSession)) {
      setPanelOpen(true);
    } else {
      const session = Object.values(state.sessions)
        .filter((s) => isReusableSession(s))
        .sort(compareLocalChatSessionRecency)[0];
      if (session) {
        focusSession(session.id);
        setPanelOpen(true);
      } else {
        void openChat("New Chat", projectPath);
      }
    }
  }, [focusSession, openChat, setPanelOpen, togglePanel]);

  // Double-tap Alt to toggle. Ignore auto-repeat from a held key; use the
  // event's monotonic timeStamp to measure the gap between discrete presses.
  useEffect(() => {
    let lastAlt: number | null = null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Alt" || event.repeat) return;
      if (lastAlt !== null && event.timeStamp - lastAlt < DOUBLE_TAP_MS) {
        lastAlt = null;
        void toggleChat();
      } else {
        lastAlt = event.timeStamp;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleChat]);

  // While the panel is open it owns the bottom-right anchor; hide the pill.
  if (panelOpen) return null;

  return (
    <button
      type="button"
      className="hc-launch"
      data-testid="local-chat-launcher"
      onClick={() => void toggleChat()}
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
