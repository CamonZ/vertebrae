import { expect, it } from "vitest";
import {
  withFileReferenceReplyIds,
  fileReferenceReplyTurns,
} from "./fileReferenceReplyIds";
import type { ChatMessage } from "../stores/chatStore";

const assistant = (
  timestamp: string,
  text = "`src/a.ts`"
): Extract<ChatMessage, { kind: "assistant" }> => ({
  kind: "assistant",
  timestamp,
  text,
});

it("isolates same-timestamp legacy replies and preserves provider identity", () => {
  const replies = withFileReferenceReplyIds([
    assistant("same"),
    assistant("same"),
    { ...assistant("same"), itemId: "provider-item" },
  ]);

  expect(
    new Set(
      replies.map(
        (reply) => reply.kind === "assistant" && reply.referenceReplyId
      )
    ).size
  ).toBe(3);
  expect(replies[2]).toMatchObject({ referenceReplyId: "provider-item" });
});

it("keeps legacy identity stable across edits, pagination and presentation segmentation", () => {
  const original = withFileReferenceReplyIds([assistant("time")])[0];
  const paginated = withFileReferenceReplyIds([
    assistant("older"),
    assistant("time", "Edited reply"),
  ])[1];

  expect(original.kind === "assistant" && original.referenceReplyId).toBe(
    paginated.kind === "assistant" && paginated.referenceReplyId
  );

  const enriched = withFileReferenceReplyIds([
    assistant("same"),
    assistant("same"),
  ]);

  expect(withFileReferenceReplyIds(enriched.slice(1))).toEqual(
    enriched.slice(1)
  );
});

it("shares a reply lookup for the immutable message array, including legacy replies", () => {
  const messages = [
    {
      kind: "assistant" as const,
      turnId: "turn",
      text: "old",
      timestamp: "then",
    },
  ];
  const first = fileReferenceReplyTurns(messages);
  expect(fileReferenceReplyTurns(messages)).toBe(first);
  const reply = withFileReferenceReplyIds(messages)[0];
  if (reply.kind !== "assistant") throw new Error("fixture");
  expect(first.get(reply.referenceReplyId!)).toBe("turn");
  const later = [
    ...messages,
    {
      kind: "assistant" as const,
      itemId: "second",
      turnId: "next",
      text: "new",
      timestamp: "now",
    },
  ];
  expect(fileReferenceReplyTurns(later)).not.toBe(first);
  expect(fileReferenceReplyTurns(later).get("second")).toBe("next");
  expect(first.has("second")).toBe(false);
});
