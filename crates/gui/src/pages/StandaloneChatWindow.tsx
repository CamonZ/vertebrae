import { useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { ChatWindow } from "../components/ChatWindow/ChatWindow";
import { WindowLayout } from "../components/WindowLayout";
import { useChatStore } from "../stores/chatStore";
import { takeStashedChatSession } from "../utils/chatStash";

/**
 * Standalone page rendered by the `/chat?sessionId=...` pop-out window.
 *
 * Each Tauri webview is a separate JS process, so this window's
 * `useChatStore` starts empty. The parent stashes the focal `ChatSession`
 * in `localStorage` before opening us; we read+delete it synchronously
 * before first paint and seed the store so `ChatWindow` and
 * `useScopedChat` find the session immediately. The existing
 * `claudeSessionId` is preserved so `useScopedChat` does NOT recreate the
 * backend session — Claude streaming events are broadcast to all windows
 * and will resume flowing into this one as soon as the hook mounts.
 */
export function StandaloneChatWindow() {
  const [params] = useSearchParams();
  const sessionId = params.get("sessionId");

  const seededRef = useRef(false);
  if (!seededRef.current && sessionId) {
    seededRef.current = true;
    const stashed = takeStashedChatSession(sessionId);
    if (stashed) {
      useChatStore.setState((state) => ({
        sessions: { ...state.sessions, [stashed.id]: stashed },
        activeSessionId: stashed.id,
      }));
    }
  }

  if (!sessionId) {
    return (
      <WindowLayout>
        <div className="flex h-full items-center justify-center text-sm text-text-muted">
          Missing sessionId query parameter
        </div>
      </WindowLayout>
    );
  }

  return (
    <WindowLayout>
      <ChatWindow sessionId={sessionId} />
    </WindowLayout>
  );
}
