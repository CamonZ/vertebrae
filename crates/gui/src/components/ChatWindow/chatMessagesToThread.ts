/**
 * chatMessagesToThread — adapter: chatStore `ChatMessage[]` → canonical
 * `Thread` for the unified <Thread> primitive (chat surface).
 *
 * Sub-agent scoping (the reason this isn't a flat walk): tool calls/results a
 * Task/Agent spawns carry `parentToolUseId`. We convert each chat message into
 * the shared `ConversationEvent` shape and hand each turn to
 * {@link chatTurnEventsToMessages}, which reuses the SAME `groupBySpawn` the
 * Traces normalizer uses — so a spawned sub-agent surfaces as a nested
 * `SpawnMessage` child thread instead of its tool rows leaking into the main
 * stream. With no sub-agent linkage this degrades to a flat series.
 *
 * Grouping contract:
 *   · session_start / session_end → dropped (no row).
 *   · user                        → opens a new Turn with a UserMessage
 *                                   {role:'human', label:'You'}.
 *   · assistant / tool_call / tool_result → buffered as ConversationEvents and
 *                                   grouped (sub-agent nesting) per turn.
 *   · error / warning             → a terminal ErrorMessage in its own turn.
 *   · permission_request          → SKIPPED here; ChatWindow renders the
 *                                   interactive PermissionRequestTurn as a
 *                                   sibling of <Thread>.
 *
 * Two chat-specific concerns are restored after grouping (the shared helpers
 * are trace-shaped): a trailing partial assistant marks its agent row
 * `streaming`, and agent/error rows get deterministic keys (the grouping
 * helper keys them off a module counter, which churns across renders).
 *
 * Returns ONE Thread{id:'local-chat-thread'} — rendered depth=0, no head.
 */

import type { ChatMessage } from "../../stores/chatStore";
import {
  getToolIcon,
  type ConversationEvent,
} from "../../types/conversation";
import { chatTurnEventsToMessages } from "../thread/normalize";
import type {
  AgentMessage,
  ErrorMessage,
  Message,
  Thread,
  Turn,
  UserMessage,
} from "../thread/types";

export interface ChatThreadOptions {
  /** Toggle a tool body's collapsed state (interactive surfaces). */
  onToggleTool?: (toolId: string) => void;
  /**
   * Optional set of tool ids whose bodies are currently COLLAPSED. When omitted,
   * tools start collapsed and the row self-toggles on click (uncontrolled).
   */
  collapsed?: Set<string>;
  /**
   * Sub-agent (sidechain) messages keyed by their parent spawn `tool_use` id.
   * The caller extracts these from the main chronological stream so a permission
   * segment boundary can't separate a spawn from its children; here they are
   * re-injected immediately after the matching spawn `tool_call` so the
   * sub-agent nests in place (not as an orphaned thread dumped at the bottom).
   */
  childrenByParent?: Map<string, ChatMessage[]>;
  /**
   * Whether the chat is awaiting a response. Carried for parity with the caller;
   * not consumed here (the ThinkingIndicator is a sibling of <Thread>).
   */
  isWaiting?: boolean;
}

/** Stable thread id for the single local-chat thread. */
export const LOCAL_CHAT_THREAD_ID = "local-chat-thread";

export function chatMessagesToThread(
  messages: readonly ChatMessage[],
  opts: ChatThreadOptions
): Thread {
  const { onToggleTool, collapsed, childrenByParent } = opts;

  const turns: Turn[] = [];
  let turnSeq = 0;

  // Current turn accumulator.
  let userMsg: UserMessage | null = null;
  let events: ConversationEvent[] = [];
  let endsWithPartialAssistant = false;

  const flushTurn = () => {
    if (!userMsg && events.length === 0) return;
    const turnId = `chat-turn-${turnSeq++}`;
    const grouped = chatTurnEventsToMessages(events, { collapsed, onToggleTool });
    stabilizeKeys(grouped, turnId);
    if (endsWithPartialAssistant) markLastAgentStreaming(grouped);
    const messagesOut: Message[] = userMsg ? [userMsg, ...grouped] : grouped;
    turns.push({ id: turnId, messages: messagesOut });
    userMsg = null;
    events = [];
    endsWithPartialAssistant = false;
  };

  for (const m of messages) {
    switch (m.kind) {
      case "session_start":
      case "session_end":
      case "permission_request":
        continue;

      case "user": {
        flushTurn();
        userMsg = {
          evt: `chat-turn-${turnSeq}-user`,
          type: "user",
          role: "human",
          label: "You",
          text: m.text,
        };
        continue;
      }

      case "assistant": {
        events.push({
          kind: "assistant_message",
          text: m.text,
          timestamp: m.timestamp,
        });
        endsWithPartialAssistant = m.isPartial === true;
        continue;
      }

      case "tool_call": {
        events.push(toToolCallEvent(m));
        // Re-inject this spawn's sub-agent messages right here so they nest in
        // place; groupBySpawn pairs them to this tool_call by id.
        const kids = childrenByParent?.get(m.toolId);
        if (kids) {
          for (const k of kids) {
            const ev = toChildEvent(k);
            if (ev) events.push(ev);
          }
        }
        endsWithPartialAssistant = false;
        continue;
      }

      case "tool_result": {
        events.push(toToolResultEvent(m));
        endsWithPartialAssistant = false;
        continue;
      }

      case "error":
      case "warning": {
        flushTurn();
        const turnId = `chat-turn-${turnSeq++}`;
        const err: ErrorMessage = {
          evt: `${turnId}-error`,
          type: "error",
          title: m.message,
        };
        turns.push({ id: turnId, messages: [err] });
        continue;
      }
    }
  }
  flushTurn();

  return { id: LOCAL_CHAT_THREAD_ID, turns };
}

/**
 * Give agent/error/activity rows deterministic, position-based keys. Tool and
 * spawn rows already carry stable ids (the `tool_use` id); the grouping helper
 * keys everything else off a module-global counter that changes every call,
 * which would churn React keys across renders. Recurses into sub-agent threads.
 */
function stabilizeKeys(messages: Message[], prefix: string): void {
  messages.forEach((m, i) => {
    if (m.type !== "tool" && m.type !== "spawn") {
      m.evt = `${prefix}-m${i}`;
    }
    if (m.type === "spawn") {
      m.thread.turns.forEach((t, ti) =>
        stabilizeKeys(t.messages, `${prefix}-s${i}-${ti}`)
      );
    }
  });
}

/** Mark the last top-level agent row as streaming (trailing partial assistant). */
function markLastAgentStreaming(messages: Message[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type === "agent") {
      (m as AgentMessage).streaming = true;
      return;
    }
  }
}

/** Convert a `tool_call` chat message to its ConversationEvent shape. */
function toToolCallEvent(
  m: Extract<ChatMessage, { kind: "tool_call" }>
): ConversationEvent {
  return {
    kind: "tool_call",
    toolId: m.toolId,
    toolName: m.toolName,
    displayName: m.toolName,
    icon: getToolIcon(m.toolName),
    summary: "",
    input: parseToolInput(m.input),
    timestamp: m.timestamp,
    parentToolUseId: m.parentToolUseId,
  };
}

/** Convert a `tool_result` chat message to its ConversationEvent shape. */
function toToolResultEvent(
  m: Extract<ChatMessage, { kind: "tool_result" }>
): ConversationEvent {
  return {
    kind: "tool_result",
    toolUseId: m.toolId,
    isError: m.isError,
    result: m.result,
    timestamp: m.timestamp,
    parentToolUseId: m.parentToolUseId,
  };
}

/** Convert a sub-agent child message (tool_call/tool_result) to an event. */
function toChildEvent(m: ChatMessage): ConversationEvent | null {
  if (m.kind === "tool_call") return toToolCallEvent(m);
  if (m.kind === "tool_result") return toToolResultEvent(m);
  return null;
}

/**
 * Parse a tool_call `input` JSON string into an object (the ConversationEvent
 * shape). Falls back to `{ command: <raw> }` for an unparseable string so a
 * Bash row still renders its command, else an empty object.
 */
function parseToolInput(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON — fall through.
  }
  return input ? { command: input } : {};
}
