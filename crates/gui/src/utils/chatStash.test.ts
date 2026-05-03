import { describe, it, expect, beforeEach } from "vitest";
import { stashChatSession, takeStashedChatSession } from "./chatStash";
import type { ChatSession } from "../stores/chatStore";

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "s-1",
    scope: "task",
    entityId: "task-1",
    label: "Sample",
    messages: [],
    status: "open",
    claudeSessionId: "claude-abc",
    claudeConversationId: null,
    contextSummary: null,
    ...overrides,
  };
}

describe("chatStash", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips a session through localStorage", () => {
    const session = makeSession({
      messages: [
        { kind: "user", text: "hi", timestamp: "2025-01-01T00:00:00Z" },
      ],
    });
    stashChatSession(session);

    const taken = takeStashedChatSession(session.id);
    expect(taken).not.toBeNull();
    expect(taken!.id).toBe("s-1");
    expect(taken!.claudeSessionId).toBe("claude-abc");
    expect(taken!.messages).toHaveLength(1);
    expect(taken!.messages[0]).toMatchObject({ kind: "user", text: "hi" });
  });

  it("returns null when nothing was stashed", () => {
    expect(takeStashedChatSession("missing")).toBeNull();
  });

  it("removes the entry on take so the second call returns null", () => {
    stashChatSession(makeSession());
    expect(takeStashedChatSession("s-1")).not.toBeNull();
    expect(takeStashedChatSession("s-1")).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    localStorage.setItem("chat-stash:bad", "{not-json");
    expect(takeStashedChatSession("bad")).toBeNull();
  });
});
