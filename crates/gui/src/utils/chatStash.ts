import type { ChatSession } from "../stores/chatStore";

const KEY_PREFIX = "chat-stash:";

function key(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}

/**
 * Stash a chat session in `localStorage` so a freshly-opened pop-out window
 * can seed its empty `useChatStore` synchronously before first paint.
 *
 * Tauri webviews of the same origin share `localStorage`, which makes this
 * a valid hand-off channel. Streaming Claude events are broadcast to all
 * windows, so once the pop-out's `useScopedChat` hook mounts with the
 * existing `claudeSessionId`, real-time updates resume without further
 * plumbing.
 */
export function stashChatSession(session: ChatSession): void {
  try {
    localStorage.setItem(key(session.id), JSON.stringify(session));
  } catch {
    // Out of quota or storage disabled — pop-out will see an empty session
  }
}

/**
 * Read and remove a stashed chat session. Returns null if nothing was
 * stashed or the entry is malformed.
 */
export function takeStashedChatSession(sessionId: string): ChatSession | null {
  try {
    const raw = localStorage.getItem(key(sessionId));
    if (!raw) return null;
    localStorage.removeItem(key(sessionId));
    return JSON.parse(raw) as ChatSession;
  } catch {
    return null;
  }
}
