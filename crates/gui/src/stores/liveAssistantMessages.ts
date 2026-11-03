import type { ChatMessage, ChatSession } from "./chatStore";

type AssistantMessage = Extract<ChatMessage, { kind: "assistant" }>;
export type LiveAssistantMessages = Readonly<Record<string, AssistantMessage>>;

export function liveAssistantKey(message: AssistantMessage): string {
  return JSON.stringify([
    message.turnId ?? null,
    message.itemId,
    message.parentToolUseId ?? null,
  ]);
}

export function indexLiveAssistantMessages(
  messages: readonly ChatMessage[]
): LiveAssistantMessages {
  return Object.fromEntries(
    messages.flatMap((message) =>
      message.kind === "assistant" &&
      message.itemId &&
      (message.lifecycle ?? (message.isPartial ? "streaming" : "completed")) ===
        "streaming"
        ? [[liveAssistantKey(message), message]]
        : []
    )
  );
}

/** Materialize at semantic boundaries, never on a text-only publication. */
export function materializeLiveAssistantMessages(
  session: ChatSession
): ChatSession {
  const live = session.liveAssistantMessages;
  if (!live || Object.keys(live).length === 0) return session;

  return {
    ...session,
    messages: session.messages.map((message) =>
      message.kind === "assistant" && message.itemId
        ? (live[liveAssistantKey(message)] ?? message)
        : message
    ),
    liveAssistantMessages: undefined,
  };
}

/** Retain live text for unchanged slots across semantic transcript edits. */
export function reconcileLiveAssistantMessages(
  previous: ChatSession,
  messages: readonly ChatMessage[]
): LiveAssistantMessages | undefined {
  const live = indexLiveAssistantMessages(messages);
  if (Object.keys(live).length === 0) return undefined;

  const slots = new Map(
    previous.messages.flatMap((message) =>
      message.kind === "assistant" && message.itemId
        ? [[liveAssistantKey(message), message] as const]
        : []
    )
  );

  return Object.fromEntries(
    Object.entries(live).map(([key, message]) => [
      key,
      slots.get(key) === message
        ? (previous.liveAssistantMessages?.[key] ?? message)
        : message,
    ])
  );
}
