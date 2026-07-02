/**
 * chatMessagesToThread — adapter: chatStore `ChatMessage[]` → canonical
 * `Thread` for the unified <Thread> primitive (chat surface).
 *
 * Child-agent transcript rows carry `parentToolUseId`. The parent chat does
 * not inline those rows; it keeps the parent Agent/Task tool call as the
 * chronological marker and leaves child exploration to the mini panel.
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
import { getToolIcon, type ConversationEvent } from "../../types/conversation";
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
   * Whether the chat is awaiting a response. Carried for parity with the caller;
   * not consumed here (the ThinkingIndicator is a sibling of <Thread>).
   */
  isWaiting?: boolean;
  /** Provider label shown on assistant response rows. */
  assistantLabel?: string;
}

/** Stable thread id for the single local-chat thread. */
export const LOCAL_CHAT_THREAD_ID = "local-chat-thread";

export function chatMessagesToThread(
  messages: readonly ChatMessage[],
  opts: ChatThreadOptions
): Thread {
  const { onToggleTool, collapsed, assistantLabel } = opts;

  const turns: Turn[] = [];
  let turnSeq = 0;

  // Current turn accumulator.
  let userMsg: UserMessage | null = null;
  let events: ConversationEvent[] = [];
  let endsWithPartialAssistant = false;
  const hiddenToolIds = new Set<string>();

  const flushTurn = () => {
    if (!userMsg && events.length === 0) return;
    const turnId = `chat-turn-${turnSeq++}`;
    const grouped = chatTurnEventsToMessages(events, {
      collapsed,
      onToggleTool,
      assistantLabel,
    });
    stabilizeKeys(grouped, turnId);
    if (endsWithPartialAssistant) markLastAgentStreaming(grouped);
    const messagesOut: Message[] = userMsg ? [userMsg, ...grouped] : grouped;
    turns.push({ id: turnId, messages: messagesOut });
    userMsg = null;
    events = [];
    endsWithPartialAssistant = false;
  };

  for (const m of messages) {
    if (
      (m.kind === "assistant" ||
        m.kind === "tool_call" ||
        m.kind === "tool_result") &&
      m.parentToolUseId
    ) {
      continue;
    }
    if (m.kind === "tool_result" && hiddenToolIds.has(m.toolId)) {
      continue;
    }

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
          textFormat: "markdown",
        };
        continue;
      }

      case "assistant": {
        events.push({
          kind: "assistant_message",
          text: m.text,
          timestamp: m.timestamp,
          parentToolUseId: m.parentToolUseId,
        });
        endsWithPartialAssistant = m.isPartial === true;
        continue;
      }

      case "tool_call": {
        if (isNonSpawnAgentControlCall(m)) {
          hiddenToolIds.add(m.toolId);
          continue;
        }
        events.push(toToolCallEvent(m));
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

function isNonSpawnAgentControlCall(
  m: Extract<ChatMessage, { kind: "tool_call" }>
): boolean {
  if (!/^(agent|task)$/i.test(m.toolName)) return false;
  const input = parseToolInput(m.input);
  const collabTool = input.collab_tool ?? input.collabTool;
  return typeof collabTool === "string" && collabTool !== "spawnAgent";
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
