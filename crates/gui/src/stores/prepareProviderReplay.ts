import type { ChatMessage, ChatSession } from "./chatStore";
import {
  parseSessionLogs,
  type ConversationEvent,
} from "../types/conversation";
import { sanitizeSessionMessages } from "./chatMessagePolicy";
import {
  mergeReplayMessages,
  reconcileReplayMessages,
  unmatchedMessages,
} from "./providerReplayMerge";

export type ReplayContext = Pick<
  ChatSession,
  "id" | "createdAt" | "providerResumeId"
>;

export interface ReplayPreparation {
  kind: "initial" | "older";
  refresh: boolean;
  lines: string[];
  context: ReplayContext;
  previousInstalled: ChatMessage[];
  messages: ChatMessage[];
}

export interface PreparedReplay {
  /** Replay projection alone, kept so a conflicting result can be rebased. */
  projected: ChatMessage[];
  messages: ChatMessage[];
  installedMessageCount: number;
}

/**
 * Project replay lines (the expensive step) and merge them with the session
 * snapshot in `input`. Merged messages reuse projected objects, so returning
 * both adds only an array of references to the structured clone.
 */
export function prepareProviderReplay(
  input: ReplayPreparation
): PreparedReplay {
  const projected = replayLinesToChatMessages(input.lines, input.context);
  return { projected, ...mergeProjectedReplay(projected, input) };
}

/** Merge an existing projection with a (possibly newer) session snapshot. */
export function mergeProjectedReplay(
  projected: ChatMessage[],
  input: Omit<ReplayPreparation, "lines" | "context">
): { messages: ChatMessage[]; installedMessageCount: number } {
  const currentPrefix = input.messages.slice(0, input.previousInstalled.length);

  const reconciled =
    input.refresh || input.kind === "older"
      ? reconcileReplayMessages(
          projected,
          input.previousInstalled,
          currentPrefix
        )
      : projected;
  const liveMessages =
    input.refresh || input.kind === "older"
      ? [
          ...unmatchedMessages(input.previousInstalled, currentPrefix),
          ...input.messages.slice(input.previousInstalled.length),
        ]
      : input.messages;

  if (input.kind === "older") {
    const messages = [...reconciled, ...liveMessages];
    return { messages, installedMessageCount: messages.length };
  }

  return mergeReplayMessages(reconciled, liveMessages);
}

function conversationEventToChatMessage(
  event: ConversationEvent
): ChatMessage | null {
  switch (event.kind) {
    case "gate_evaluation":
      return {
        kind: "gate_evaluation",
        attempt: event.attempt,
        verdict: event.verdict,
        timestamp: event.timestamp,
      };
    case "user_message":
      return { kind: "user", text: event.text, timestamp: event.timestamp };
    case "assistant_message":
      return {
        kind: "assistant",
        text: event.text,
        timestamp: event.timestamp,
        ...(event.itemId ? { itemId: event.itemId } : {}),
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.lifecycle
          ? {
              lifecycle: event.lifecycle,
              isPartial: event.lifecycle === "streaming",
            }
          : {}),
        ...(event.parentToolUseId
          ? { parentToolUseId: event.parentToolUseId }
          : {}),
      };
    case "tool_call":
      return {
        kind: "tool_call",
        toolName: event.toolName,
        toolId: event.toolId,
        input: JSON.stringify(event.input ?? {}),
        timestamp: event.timestamp,
        ...(event.parentToolUseId
          ? { parentToolUseId: event.parentToolUseId }
          : {}),
      };
    case "tool_result":
      return {
        kind: "tool_result",
        toolId: event.toolUseId,
        result: event.result,
        isError: event.isError,
        timestamp: event.timestamp,
        ...(event.parentToolUseId
          ? { parentToolUseId: event.parentToolUseId }
          : {}),
      };
    case "file_edit":
      return {
        kind: "file_edit",
        toolId: event.toolId,
        status: event.status,
        changes: event.changes,
        timestamp: event.timestamp,
        ...(event.parentToolUseId
          ? { parentToolUseId: event.parentToolUseId }
          : {}),
      };
    case "session_start":
      return {
        kind: "session_start",
        model: event.model,
        timestamp: event.timestamp,
      };
    case "session_end":
      return {
        kind: "session_end",
        ...(event.successful !== undefined
          ? { successful: event.successful }
          : {}),
        durationMs: event.durationMs,
        costUsd: event.costUsd,
        numTurns: event.numTurns,
        timestamp: event.timestamp,
      };
    case "task_notification":
      return {
        kind: "task_notification",
        message: event.message,
        timestamp: event.timestamp,
      };
    case "thinking":
      return event.text.startsWith("[error]")
        ? {
            kind: "error",
            message: event.text.replace(/^\[error\]\s*/, ""),
            timestamp: event.timestamp,
          }
        : null;
    default:
      return null;
  }
}

/**
 * Project accumulated replay lines into chat messages.
 *
 * Log IDs are derived from each line's own harness event ID (not list
 * position) so prepending an older page never shifts the identity of
 * already-projected lines. Re-projecting the full accumulated line list is
 * intentional: `parseSessionLogs` is stateful across lines (delta merging,
 * tool-pair and file-edit pairing), so a page boundary is not a projection
 * boundary.
 */
export function replayLinesToChatMessages(
  lines: string[],
  session: ReplayContext
): ChatMessage[] {
  const logs = lines.map((content) => {
    let eventId: string | undefined;

    try {
      const parsed: unknown = JSON.parse(content);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "event_id" in parsed &&
        typeof (parsed as { event_id: unknown }).event_id === "string"
      ) {
        eventId = (parsed as { event_id: string }).event_id;
      }
    } catch {
      eventId = undefined;
    }

    return {
      id: eventId
        ? `local-replay-${session.id}-${eventId}`
        : `local-replay-${session.id}-${contentDigest(content)}`,
      step_execution_id: session.id,
      content,
      format: "harness",
      created_at: session.createdAt ?? "",
    };
  });

  return sanitizeSessionMessages(
    parseSessionLogs(logs)
      .map(conversationEventToChatMessage)
      .filter((message): message is ChatMessage => message !== null),
    session.providerResumeId
  );
}

/** Deterministic content digest for lines without a harness event ID. */
function contentDigest(content: string): string {
  let hash = 0;

  for (let index = 0; index < content.length; index += 1) {
    hash = (Math.imul(31, hash) + content.charCodeAt(index)) | 0;
  }

  return (hash >>> 0).toString(36);
}
