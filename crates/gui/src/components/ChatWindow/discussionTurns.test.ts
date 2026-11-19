import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../stores/chatStore";
import { collapseTurns, earlierTurnsLabel } from "./discussionTurns";

const user = (text: string): ChatMessage => ({ kind: "user", text, timestamp: "t" });
const reply = (text: string): ChatMessage => ({ kind: "assistant", text, timestamp: "t" });

describe("collapseTurns", () => {
  it("keeps only the reply to the latest question", () => {
    const messages = [user("q1"), reply("a1"), user("q2"), reply("a2"), user("q3"), reply("a3")];
    expect(collapseTurns(messages)).toEqual({ earlier: 2, latest: [reply("a3")] });
  });

  it("shows a reply still arriving as the latest response", () => {
    const messages = [user("q1"), reply("a1"), user("q2")];
    expect(collapseTurns(messages)).toEqual({ earlier: 1, latest: [] });
  });

  it("hides nothing without a question", () => {
    const messages = [reply("restored")];
    expect(collapseTurns(messages)).toEqual({ earlier: 0, latest: messages });
  });
});

it("labels the earlier turns row", () => {
  expect(earlierTurnsLabel(1)).toBe("1 earlier turn");
  expect(earlierTurnsLabel(2)).toBe("2 earlier turns");
});
