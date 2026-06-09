/**
 * liveChatToThread — the Sacrum REST/WS LiveChat adapter.
 *
 * Normalize-on-render: turn the live chat store's flat `LiveChatMessage[]` into
 * ONE canonical `Thread` (id 'live-chat-thread') rendered by the unified
 * <Thread> primitive with chat capability flags
 *   mode="bare" reveal="shallow" interactive showHead={false}
 *
 * LiveChat is NOT token-streamed: the backend delivers WHOLE messages, so
 * "streaming" here is message-granular — `m.pending` (an optimistic, not-yet-
 * reconciled message) maps to AgentMessage.streaming for the blinking cursor /
 * speaker spinner.
 *
 * Turn boundaries mirror {@link msgsToThread}: a NON-assistant (human) message
 * opens a new Turn carrying a UserMessage; an assistant message attaches an
 * AgentMessage to the open turn (opening one if none exists — the leading-
 * assistant guard). A message with an `error` appends a trailing ErrorMessage
 * in the SAME turn. Order is preserved.
 */

import type { LiveChatMessage } from "../../stores/liveChatStore";
import type {
  AgentMessage,
  ErrorMessage,
  ThreadModel,
  Turn,
  UserMessage,
} from "../thread";

/** Stable id for the single live-chat thread. */
export const LIVE_CHAT_THREAD_ID = "live-chat-thread";

/**
 * Pure adapter: `LiveChatMessage[]` → one `Thread`. See module header.
 */
export function liveChatToThread(messages: LiveChatMessage[]): ThreadModel {
  const turns: Turn[] = [];
  let cur: Turn | null = null;

  for (const m of messages) {
    if (m.role !== "assistant") {
      // A human message opens a new turn.
      cur = { id: "t" + m.id, messages: [] };
      turns.push(cur);
      const um: UserMessage = {
        evt: m.id,
        type: "user",
        role: "human",
        label: "You",
        text: m.content,
      };
      cur.messages.push(um);
    } else {
      // An assistant message attaches to the open turn (open one if none —
      // mirrors msgsToThread's !cur guard for a leading assistant message).
      if (!cur) {
        cur = { id: "t" + m.id, messages: [] };
        turns.push(cur);
      }
      const am: AgentMessage = {
        evt: m.id,
        type: "agent",
        speaker: "Claude",
        model: undefined,
        streaming: m.pending,
        prose: m.content,
      };
      cur.messages.push(am);
    }

    // A failed message surfaces a trailing ErrorMessage in the SAME turn.
    if (m.error) {
      const em: ErrorMessage = {
        evt: m.id + "-error",
        type: "error",
        title: "Failed to send",
        sub: m.error,
      };
      cur.messages.push(em);
    }
  }

  return { id: LIVE_CHAT_THREAD_ID, turns };
}
