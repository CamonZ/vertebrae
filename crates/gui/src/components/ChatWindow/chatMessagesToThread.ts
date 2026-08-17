/**
 * chatMessagesToThread — adapter: chatStore `ChatMessage[]` → canonical
 * `Thread` for the unified <Thread> primitive (chat surface).
 *
 * Child-agent transcript rows carry `parentToolUseId`, but the local chat view
 * deliberately does not expand child work inline. The mini panel owns navigation
 * into child threads; the parent chat keeps only the spawn/status rows and any
 * explicit main-thread result rows emitted by the harness.
 *
 * Correlation is SESSION-wide, not per turn: tool results are indexed across
 * all turns (a long-running call's result can arrive after the next user
 * message).
 *
 * Grouping contract:
 *   · session_start / session_end → dropped (no row).
 *   · user                        → opens a new Turn with a UserMessage
 *                                   {role:'human', label:'You'}.
 *   · assistant / tool_call / tool_result → buffered as ConversationEvents and
 *                                   grouped per turn; child-linked events are
 *                                   skipped on this surface.
 *   · task_notification           → buffered as an activity ConversationEvent
 *                                   (renders as a harness notice row).
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
  type FileEditEvent,
  type ToolCallEvent,
  type ToolResultEvent,
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
   * Optional set of tool ids whose bodies are currently EXPANDED. This takes
   * precedence over `collapsed` and lets callers preserve state across row
   * unmounts without discovering every new tool id in advance.
   */
  expanded?: ReadonlySet<string>;
  /** Tool ids whose bounded bodies currently show the complete content. */
  fullContent?: ReadonlySet<string>;
  /** Toggle a tool body's bounded full-content rendering. */
  onToggleFullContent?: (toolId: string) => void;
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

/** One turn's worth of buffered content before grouping. */
interface TurnDraft {
  userText: string | null;
  events: ConversationEvent[];
  endsWithPartialAssistant: boolean;
  /** Set for a standalone error/warning turn (no events). */
  errorTitle?: string;
}

export function chatMessagesToThread(
  messages: readonly ChatMessage[],
  opts: ChatThreadOptions
): Thread {
  const {
    onToggleTool,
    collapsed,
    expanded,
    fullContent,
    onToggleFullContent,
    assistantLabel,
  } = opts;

  // ── Pass 1: bucket messages into turn drafts ──────────────────────────
  // Correlation state is SESSION-wide, not per turn: a tool_result can land
  // in a later turn than its tool_call (long-running commands), so keep one
  // result index for all turns.
  const drafts: TurnDraft[] = [];
  const resultById = new Map<string, ToolResultEvent>();
  const seenToolCallIds = new Set<string>();
  const toolCallById = new Map<string, ToolCallEvent>();
  const fileEditIds = new Set(
    messages
      .filter(
        (message): message is Extract<ChatMessage, { kind: "file_edit" }> =>
          message.kind === "file_edit" && message.toolId.length > 0
      )
      .map((message) => message.toolId)
  );

  let current: TurnDraft | null = null;
  const openDraft = (): TurnDraft => {
    if (!current) {
      current = {
        userText: null,
        events: [],
        endsWithPartialAssistant: false,
      };
      drafts.push(current);
    }
    return current;
  };

  for (const m of messages) {
    switch (m.kind) {
      case "session_start":
      case "session_end":
      case "permission_request":
      case "user_question":
        continue;

      case "user": {
        current = {
          userText: m.text,
          events: [],
          endsWithPartialAssistant: false,
        };
        drafts.push(current);
        continue;
      }

      case "assistant": {
        if (m.parentToolUseId) continue;
        const draft = openDraft();
        draft.events.push({
          kind: "assistant_message",
          text: m.text,
          timestamp: m.timestamp,
          parentToolUseId: m.parentToolUseId,
        });
        draft.endsWithPartialAssistant = m.isPartial === true;
        continue;
      }

      case "tool_call": {
        if (m.parentToolUseId) continue;
        if (fileEditIds.has(m.toolId)) continue;
        if (isNonSpawnAgentControlMessage(m)) continue;
        const ev = toToolCallEvent(m);
        if (seenToolCallIds.has(m.toolId)) {
          mergeToolCallEvent(toolCallById.get(m.toolId), ev);
          continue;
        }
        seenToolCallIds.add(m.toolId);
        toolCallById.set(m.toolId, ev);
        const draft = openDraft();
        draft.events.push(ev);
        draft.endsWithPartialAssistant = false;
        continue;
      }

      case "tool_result": {
        if (m.parentToolUseId) continue;
        if (fileEditIds.has(m.toolId)) continue;
        const draft = openDraft();
        const ev = toToolResultEvent(m);
        draft.events.push(ev);
        draft.endsWithPartialAssistant = false;
        if (!resultById.has(ev.toolUseId)) resultById.set(ev.toolUseId, ev);
        continue;
      }

      case "file_edit": {
        if (m.parentToolUseId) continue;
        const draft = openDraft();
        const ev: FileEditEvent = {
          kind: "file_edit",
          toolId: m.toolId,
          status: m.status,
          changes: m.changes,
          timestamp: m.timestamp,
          parentToolUseId: m.parentToolUseId,
        };
        draft.events.push(ev);
        draft.endsWithPartialAssistant = false;
        continue;
      }

      case "task_notification": {
        // Harness notice → activity row (markLastAgentStreaming skips
        // activity rows, so a trailing partial assistant stays streaming).
        openDraft().events.push({
          kind: "task_notification",
          message: m.message,
          timestamp: m.timestamp,
        });
        continue;
      }

      case "error":
      case "warning": {
        drafts.push({
          userText: null,
          events: [],
          endsWithPartialAssistant: false,
          errorTitle: m.message,
        });
        current = null;
        continue;
      }
    }
  }

  // ── Pass 2: group each turn (sharing the session-wide result index) ───
  const turns: Turn[] = [];
  drafts.forEach((draft, index) => {
    const turnId = `chat-turn-${index}`;
    if (draft.errorTitle !== undefined) {
      const err: ErrorMessage = {
        evt: `${turnId}-error`,
        type: "error",
        title: draft.errorTitle,
      };
      turns.push({ id: turnId, messages: [err] });
      return;
    }
    const grouped = chatTurnEventsToMessages(draft.events, {
      collapsed,
      expanded,
      onToggleTool,
      fullContent,
      onToggleFullContent,
      assistantLabel,
      resultById,
    });
    stabilizeKeys(grouped, turnId);
    if (draft.endsWithPartialAssistant) markLastAgentStreaming(grouped);
    const userMsg: UserMessage | null =
      draft.userText !== null
        ? {
            evt: `${turnId}-user`,
            type: "user",
            role: "human",
            label: "You",
            text: draft.userText,
            textFormat: "markdown",
          }
        : null;
    const messagesOut: Message[] = userMsg ? [userMsg, ...grouped] : grouped;
    if (messagesOut.length > 0) {
      turns.push({ id: turnId, messages: messagesOut });
    }
  });

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
): ToolCallEvent {
  const input = parseToolInput(m.input);
  return {
    kind: "tool_call",
    toolId: m.toolId,
    toolName: m.toolName,
    displayName: m.toolName,
    icon: getToolIcon(m.toolName),
    summary: toolCallSummary(input),
    input,
    timestamp: m.timestamp,
    parentToolUseId: m.parentToolUseId,
  };
}

function mergeToolCallEvent(
  target: ToolCallEvent | undefined,
  incoming: ToolCallEvent
): void {
  if (!target) return;
  target.input = mergeToolCallInput(target.input, incoming.input);
  target.summary =
    toolCallSummary(target.input) || incoming.summary || target.summary;
}

function mergeToolCallInput(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...current,
    ...incoming,
    agents_states: mergeRecordField(
      current.agents_states,
      incoming.agents_states
    ),
    agentsStates: mergeRecordField(current.agentsStates, incoming.agentsStates),
  };
}

function mergeRecordField(current: unknown, incoming: unknown): unknown {
  if (
    current &&
    typeof current === "object" &&
    !Array.isArray(current) &&
    incoming &&
    typeof incoming === "object" &&
    !Array.isArray(incoming)
  ) {
    return {
      ...(current as Record<string, unknown>),
      ...(incoming as Record<string, unknown>),
    };
  }
  return incoming ?? current;
}

/** Convert a `tool_result` chat message to its ConversationEvent shape. */
function toToolResultEvent(
  m: Extract<ChatMessage, { kind: "tool_result" }>
): ToolResultEvent {
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

function toolCallSummary(input: Record<string, unknown>): string {
  for (const key of ["description", "prompt"] as const) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function isNonSpawnAgentControlMessage(
  m: Extract<ChatMessage, { kind: "tool_call" }>
): boolean {
  if (m.toolName !== "agent") return false;
  const input = parseToolInput(m.input);
  const collabTool = input.collab_tool ?? input.collabTool;
  return typeof collabTool === "string" && collabTool !== "spawnAgent";
}
