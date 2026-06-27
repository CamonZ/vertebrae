import { useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { ChatWindow } from "../components/ChatWindow/ChatWindow";
import { GlobalEntityPanelHost } from "../components/GlobalEntityPanelHost";
import { WindowLayout } from "../components/WindowLayout";
import { useChatStore } from "../stores/chatStore";
import { takeStashedChatSession } from "../utils/chatStash";
import { loadPersistedLocalChatSession } from "../utils/localChatPersistence";

/**
 * Standalone page rendered by the `/chat?sessionId=...` pop-out window.
 *
 * Each Tauri webview is a separate JS process, so this window's
 * `useChatStore` starts empty. The parent stashes the focal `ChatSession`
 * in `localStorage` before opening us; we read+delete it synchronously
 * before first paint and seed the store so `ChatWindow` and
 * `useLocalChat` find the session immediately. The one-shot stash preserves
 * a live `claudeSessionId`; durable fallback hydration keeps the Claude
 * conversation ID so the backend can resume without trusting a stale process
 * local session ID.
 */
export function StandaloneChatWindow() {
  const [params] = useSearchParams();
  const sessionId = params.get("sessionId");

  const seededRef = useRef(false);
  if (!seededRef.current && sessionId) {
    seededRef.current = true;
    const seeded =
      takeStashedChatSession(sessionId) ??
      loadPersistedLocalChatSession(sessionId);
    if (seeded) {
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [seeded.id]: { ...seeded, isDetached: false },
        },
        activeSessionId: seeded.id,
      }));
    }
  }

  if (!sessionId) {
    return (
      <WindowLayout>
        <div className="flex h-full items-center justify-center text-sm text-fg-mute">
          Missing sessionId query parameter
        </div>
      </WindowLayout>
    );
  }

  return (
    <WindowLayout>
      <ChatWindow sessionId={sessionId} />
      <GlobalEntityPanelHost />
    </WindowLayout>
  );
}
