import type { ChatMessage } from "../../stores/chatStore";

export interface CollapsedTurns {
  /** Turns hidden above the latest response. */
  earlier: number;
  /** The latest response: everything after the last question. */
  latest: readonly ChatMessage[];
}

/**
 * A discussion's collapsed view: only the reply to the latest question, which
 * includes a reply still streaming in. A turn starts at each user message.
 */
export function collapseTurns(messages: readonly ChatMessage[]): CollapsedTurns {
  let last = -1;
  let questions = 0;
  messages.forEach((message, index) => {
    if (message.kind !== "user") return;
    last = index;
    questions += 1;
  });
  if (last < 0) return { earlier: 0, latest: messages };

  return { earlier: questions - 1, latest: messages.slice(last + 1) };
}

export function earlierTurnsLabel(count: number): string {
  return `${count} earlier ${count === 1 ? "turn" : "turns"}`;
}
