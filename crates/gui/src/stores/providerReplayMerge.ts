/**
 * Pure merge helpers for progressive provider transcript replay.
 *
 * Projected replay pages must merge with live session state without
 * clobbering enrichments that arrived after the last installed page (resolved
 * permission requests, completed file edits). Every helper here is pure and
 * keyed by message identity + occurrence, so duplicate messages merge
 * positionally instead of collapsing. Unmatched live messages retain their
 * position relative to matched replay messages so a live user input is not
 * moved after the replayed assistant response it produced.
 */

import type { ChatMessage } from "./chatStore";

/**
 * Stable identity for one message. Two messages with the same key are the
 * same conversational element; occurrence disambiguates repeats.
 */
function chatMessageKey(message: ChatMessage): string {
  switch (message.kind) {
    case "user":
      return `${message.kind}:${message.text}`;
    case "assistant":
      return message.itemId
        ? `${message.kind}:item:${message.itemId}`
        : `${message.kind}:legacy:${message.text}:${message.parentToolUseId ?? ""}:${message.turnId ?? ""}`;
    case "tool_call":
    case "tool_result":
      return `${message.kind}:${message.toolId}`;
    case "file_edit":
      return `${message.kind}:${message.toolId}`;
    case "permission_request":
      return `${message.kind}:${message.requestId ?? ""}:${message.toolName}:${message.message}`;
    case "user_question":
      return `${message.kind}:${message.requestId}:${message.toolUseId}`;
    case "session_start":
      return `${message.kind}:${message.model}`;
    case "session_end":
      return `${message.kind}:${message.durationMs}:${message.numTurns}`;
    case "warning":
    case "error":
    case "task_notification":
      return `${message.kind}:${message.message}`;
  }
}

/**
 * Per-message keys distinguished by occurrence. `reverse` numbers occurrences
 * from the end, so a message repeated in both replay and live state pairs
 * with its most recent counterpart even when one side has fewer copies.
 */
function occurrenceKeys(
  messages: readonly ChatMessage[],
  direction: "forward" | "reverse" = "forward"
): string[] {
  const counts = new Map<string, number>();
  const keys = new Array<string>(messages.length);
  const indexes =
    direction === "forward"
      ? messages.map((_, index) => index)
      : messages.map((_, index) => messages.length - index - 1);
  for (const index of indexes) {
    const base = chatMessageKey(messages[index]);
    const occurrence = (counts.get(base) ?? 0) + 1;
    counts.set(base, occurrence);
    keys[index] = `${base}\u0000${occurrence}`;
  }
  return keys;
}

/**
 * Keep the live version of a matched message, adopting only replay-only
 * enrichment (terminal file-edit status/changes) the live copy lacks.
 */
function mergeHydratedMatch(
  replayed: ChatMessage,
  current: ChatMessage
): ChatMessage {
  if (replayed.kind === "assistant" && current.kind === "assistant") {
    const replayLifecycle = replayed.lifecycle ??
      (replayed.isPartial ? "streaming" : "completed");
    const currentLifecycle = current.lifecycle ??
      (current.isPartial ? "streaming" : "completed");
    // Durable terminal history settles a live item that was still streaming
    // when hydration began. A newer live terminal state remains authoritative
    // when the replay page is stale.
    if (
      currentLifecycle === "streaming" &&
      replayLifecycle !== "streaming"
    ) {
      return replayed;
    }
    return current;
  }
  if (replayed.kind !== "file_edit" || current.kind !== "file_edit") {
    return current;
  }
  return {
    ...current,
    status: replayed.status,
    changes: replayed.changes.length > 0 ? replayed.changes : current.changes,
  };
}

/**
 * Merge a replayed history with the live session messages: replayed order
 * wins for matched messages, while unmatched live messages remain in their
 * current position relative to those matches.
 */
export function mergeHydratedMessages(
  hydrated: ChatMessage[],
  current: ChatMessage[]
): ChatMessage[] {
  return mergeHydratedMessagesWithBoundary(hydrated, current).messages;
}

interface HydratedMergeResult {
  messages: ChatMessage[];
  installedMessageCount: number;
}

function mergeHydratedMessagesWithBoundary(
  hydrated: ChatMessage[],
  current: ChatMessage[]
): HydratedMergeResult {
  if (current.length === 0) {
    return { messages: hydrated, installedMessageCount: hydrated.length };
  }

  const currentKeys = occurrenceKeys(current, "reverse");
  const hydratedKeys = occurrenceKeys(hydrated, "reverse");
  const currentByOccurrence = new Map(
    currentKeys.map((key, index) => [key, current[index]])
  );
  const currentIndexByOccurrence = new Map(
    currentKeys.map((key, index) => [key, index])
  );
  const hydratedKeySet = new Set(hydratedKeys);
  const anchors = hydratedKeys.flatMap((key, index) => {
    const currentIndex = currentIndexByOccurrence.get(key);
    return currentIndex === undefined
      ? []
      : [{ hydratedIndex: index, currentIndex }];
  });
  const merged: ChatMessage[] = [];
  let hydratedStart = 0;
  let currentStart = 0;

  for (const anchor of anchors) {
    for (let index = hydratedStart; index < anchor.hydratedIndex; index += 1) {
      if (!currentByOccurrence.has(hydratedKeys[index])) {
        merged.push(hydrated[index]);
      }
    }
    for (let index = currentStart; index < anchor.currentIndex; index += 1) {
      if (!hydratedKeySet.has(currentKeys[index])) {
        merged.push(current[index]);
      }
    }
    const live = currentByOccurrence.get(hydratedKeys[anchor.hydratedIndex]);
    if (live) {
      merged.push(mergeHydratedMatch(hydrated[anchor.hydratedIndex], live));
    }
    hydratedStart = anchor.hydratedIndex + 1;
    currentStart = anchor.currentIndex + 1;
  }

  for (let index = hydratedStart; index < hydrated.length; index += 1) {
    if (!currentByOccurrence.has(hydratedKeys[index])) {
      merged.push(hydrated[index]);
    }
  }
  const installedMessageCount = merged.length;
  for (let index = currentStart; index < current.length; index += 1) {
    if (!hydratedKeySet.has(currentKeys[index])) {
      merged.push(current[index]);
    }
  }
  return { messages: merged, installedMessageCount };
}

/** Merge the initial (newest) replay page into the session. */
export function mergeReplayMessages(
  replayed: ChatMessage[],
  current: ChatMessage[]
): { messages: ChatMessage[]; installedMessageCount: number } {
  return mergeHydratedMessagesWithBoundary(replayed, current);
}

/**
 * Reconcile a re-projected replay prefix against the live prefix recorded
 * when the previous page was installed: drop messages the user removed,
 * keep live enrichments, and keep replayed messages otherwise.
 */
export function reconcileReplayMessages(
  replayed: ChatMessage[],
  previousInstalled: ChatMessage[],
  currentPrefix: ChatMessage[]
): ChatMessage[] {
  const previousKeys = occurrenceKeys(previousInstalled, "reverse");
  const currentKeys = occurrenceKeys(currentPrefix, "reverse");
  const replayedKeys = occurrenceKeys(replayed, "reverse");
  const previousByKey = new Map(
    previousKeys.map((key, index) => [key, previousInstalled[index]])
  );
  const currentByKey = new Map(
    currentKeys.map((key, index) => [key, currentPrefix[index]])
  );
  const removedKeys = new Set(
    [...previousByKey.keys()].filter((key) => !currentByKey.has(key))
  );
  const liveOverrides = new Map(
    [...currentByKey.entries()].filter(([key, current]) => {
      const previous = previousByKey.get(key);
      return previous && JSON.stringify(previous) !== JSON.stringify(current);
    })
  );
  return replayed.flatMap((message, index) => {
    const key = replayedKeys[index];
    if (removedKeys.has(key)) return [];
    return [liveOverrides.get(key) ?? message];
  });
}

/** Live messages that have no counterpart in the installed replay prefix. */
export function unmatchedMessages(
  baseline: readonly ChatMessage[],
  current: readonly ChatMessage[]
): ChatMessage[] {
  const baselineKeys = new Set(occurrenceKeys(baseline));
  const currentKeys = occurrenceKeys(current);
  return current.filter((_, index) => !baselineKeys.has(currentKeys[index]));
}
