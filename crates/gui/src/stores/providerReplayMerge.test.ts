import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./chatStore";
import { mergeReplayMessages } from "./providerReplayMerge";

const user = (text: string, timestamp: string): ChatMessage => ({
  kind: "user",
  text,
  timestamp,
});

const assistant = (text: string, timestamp: string): ChatMessage => ({
  kind: "assistant",
  text,
  timestamp,
});

describe("mergeReplayMessages", () => {
  it("keeps a live user input before its replayed assistant response", () => {
    const result = mergeReplayMessages(
      [assistant("response", "2026-01-01T00:00:02Z")],
      [
        user("question", "2026-01-01T00:00:01Z"),
        assistant("response", "2026-01-01T00:00:02Z"),
      ]
    );

    expect(result.messages).toEqual([
      user("question", "2026-01-01T00:00:01Z"),
      assistant("response", "2026-01-01T00:00:02Z"),
    ]);
    expect(result.installedMessageCount).toBe(2);
  });

  it("leaves a newer live turn outside the installed replay prefix", () => {
    const result = mergeReplayMessages(
      [assistant("response", "2026-01-01T00:00:02Z")],
      [
        user("question", "2026-01-01T00:00:01Z"),
        assistant("response", "2026-01-01T00:00:02Z"),
        user("new question", "2026-01-01T00:00:03Z"),
      ]
    );

    expect(
      result.messages.map((message) =>
        message.kind === "user" || message.kind === "assistant"
          ? message.text
          : message.kind
      )
    ).toEqual(["question", "response", "new question"]);
    expect(result.installedMessageCount).toBe(2);
  });

  it("matches keyed streaming and completed items by identity, not text", () => {
    const result = mergeReplayMessages(
      [
        {
          kind: "assistant",
          itemId: "item-a",
          text: "completed A",
          timestamp: "2026-01-01T00:00:02Z",
          isPartial: false,
          lifecycle: "completed",
        },
        {
          kind: "assistant",
          itemId: "item-b",
          text: "same text",
          timestamp: "2026-01-01T00:00:03Z",
          isPartial: false,
          lifecycle: "completed",
        },
      ],
      [
        {
          kind: "assistant",
          itemId: "item-a",
          text: "partial A",
          timestamp: "2026-01-01T00:00:01Z",
          isPartial: true,
          lifecycle: "streaming",
        },
        {
          kind: "assistant",
          itemId: "item-b",
          text: "same text",
          timestamp: "2026-01-01T00:00:03Z",
          isPartial: false,
          lifecycle: "completed",
        },
      ]
    );

    expect(result.messages).toEqual([
      expect.objectContaining({
        itemId: "item-a",
        text: "completed A",
        lifecycle: "completed",
      }),
      expect.objectContaining({ itemId: "item-b", text: "same text" }),
    ]);
  });
});
