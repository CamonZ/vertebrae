import type { ChatSession } from "../stores/chatStore";
import { normalizeLocalChatSession } from "./localChatPersistence";

const KEY_PREFIX = "chat-stash:";

function key(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}

// Strip partial assistant messages while preserving lifecycle and stream state for handoff.
function handoffSession(session: ChatSession): ChatSession {
  return {
    ...session,
    messages: session.messages.filter(
      (message) => message.kind !== "assistant" || !message.isPartial
    ),
  };
}

/**
 * Stash a chat session in `localStorage` so a freshly-opened pop-out window
 * can seed its empty `useChatStore` synchronously before first paint.
 *
 * Tauri webviews of the same origin share `localStorage`, which makes this
 * a valid hand-off channel. Partial assistant messages are filtered out, while
 * the live streaming overlay is preserved; local-chat events are broadcast to
 * all windows, and the pop-out's GlobalListeners router resumes updates once
 * the stashed `backendSessionId` seeds its local store.
 */
export function stashChatSession(session: ChatSession): void {
  try {
    localStorage.setItem(
      key(session.id),
      JSON.stringify(handoffSession(session))
    );
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
    return normalizeLocalChatSession(JSON.parse(raw), {
      preserveRuntimeBackendSessionId: true,
    });
  } catch {
    return null;
  }
}

export function discardStashedChatSession(sessionId: string): void {
  try {
    localStorage.removeItem(key(sessionId));
  } catch {
    // Storage disabled; nothing to discard.
  }
}
