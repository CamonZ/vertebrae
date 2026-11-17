import type { ChatMessage } from "../stores/chatStore";

/** Provider IDs win. Legacy replies with identical timestamps remain separate;
 * pagination of other timestamps and changes to display text cannot retarget them.
 * Apply before splitting a transcript into permission/tool presentation segments. */
export function withFileReferenceReplyIds(
  messages: readonly ChatMessage[]
): ChatMessage[] {
  const counts = new Map<string, number>();

  return messages.map((message) => {
    if (message.kind !== "assistant") return message;

    const identity = JSON.stringify([
      message.turnId ?? null,
      message.timestamp,
    ]);
    const ordinal = counts.get(identity) ?? 0;
    counts.set(identity, ordinal + 1);

    return message.referenceReplyId
      ? message
      : {
          ...message,
          referenceReplyId: message.itemId ?? `legacy:${identity}:${ordinal}`,
        };
  });
}

const turnIndexes = new WeakMap<
  readonly ChatMessage[],
  ReadonlyMap<string, string>
>();
/** Chat message arrays are immutable; build one index per array, not per link. */
export function fileReferenceReplyTurns(
  messages: readonly ChatMessage[]
): ReadonlyMap<string, string> {
  const previous = turnIndexes.get(messages);
  if (previous) return previous;
  const index = new Map<string, string>();
  for (const message of withFileReferenceReplyIds(messages)) {
    if (message.kind !== "assistant" || !message.turnId) continue;
    if (message.itemId) index.set(message.itemId, message.turnId);
    if (message.referenceReplyId)
      index.set(message.referenceReplyId, message.turnId);
  }
  turnIndexes.set(messages, index);
  return index;
}
