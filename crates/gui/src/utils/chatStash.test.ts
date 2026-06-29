import { describe, it, expect, beforeEach } from "vitest";
import {
  discardStashedChatSession,
  stashChatSession,
  takeStashedChatSession,
} from "./chatStash";
import type { ChatSession } from "../stores/chatStore";

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "s-1",
    label: "Sample",
    messages: [],
    status: "open",
    backendSessionId: "claude-abc",
    providerResumeId: null,
    ...overrides,
    harness: overrides.harness ?? "claude",
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
    expect(taken!.backendSessionId).toBe("claude-abc");
    expect(taken!.messages).toHaveLength(1);
    expect(taken!.messages[0]).toMatchObject({ kind: "user", text: "hi" });
  });

  it("keeps live streaming overlay in the handoff payload", () => {
    stashChatSession(
      makeSession({
        messages: [
          {
            kind: "assistant",
            text: "partial",
            timestamp: "2025-01-01T00:00:00Z",
            isPartial: true,
          },
        ],
        lifecycle: "streaming",
        streamingAssistant: {
          text: "partial overlay",
          timestamp: "2025-01-01T00:00:00Z",
        },
      })
    );

    const taken = takeStashedChatSession("s-1");
    expect(taken).not.toBeNull();
    expect(taken!.backendSessionId).toBe("claude-abc");
    expect(taken!.lifecycle).toBe("streaming");
    expect(taken!.streamingAssistant).toMatchObject({
      text: "partial overlay",
    });
    expect(taken!.messages).toEqual([]);
  });

  it("preserves complete assistant messages during handoff", () => {
    const session = makeSession({
      messages: [
        {
          kind: "user",
          text: "hello",
          timestamp: "2025-01-01T00:00:00Z",
        },
        {
          kind: "assistant",
          text: "response",
          timestamp: "2025-01-01T00:00:01Z",
          isPartial: false,
        },
        {
          kind: "assistant",
          text: "streaming",
          timestamp: "2025-01-01T00:00:02Z",
          isPartial: true,
        },
      ],
    });

    stashChatSession(session);

    const taken = takeStashedChatSession(session.id);
    expect(taken).not.toBeNull();
    expect(taken!.messages).toHaveLength(2);
    expect(taken!.messages[0]).toMatchObject({ kind: "user", text: "hello" });
    expect(taken!.messages[1]).toMatchObject({
      kind: "assistant",
      text: "response",
      isPartial: false,
    });
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

  it("can discard a stashed session without reading it", () => {
    stashChatSession(makeSession());
    discardStashedChatSession("s-1");
    expect(takeStashedChatSession("s-1")).toBeNull();
  });
});
