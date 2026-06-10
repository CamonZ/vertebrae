import { describe, it, expect } from "vitest";
import type { LiveChatMessage } from "../../stores/liveChatStore";
import type { AgentMessage, ErrorMessage, UserMessage } from "../thread";
import { liveChatToThread, LIVE_CHAT_THREAD_ID } from "./liveChatToThread";

function makeMessage(overrides: Partial<LiveChatMessage> = {}): LiveChatMessage {
  return {
    id: "m1",
    role: "user",
    content: "hello",
    content_format: "plain",
    createdAt: "2026-05-10T12:00:00Z",
    pending: false,
    error: null,
    ...overrides,
  };
}

describe("liveChatToThread", () => {
  it("uses the stable thread id 'live-chat-thread'", () => {
    expect(liveChatToThread([]).id).toBe(LIVE_CHAT_THREAD_ID);
    expect(liveChatToThread([]).id).toBe("live-chat-thread");
  });

  it("returns no turns for an empty message list", () => {
    expect(liveChatToThread([]).turns).toEqual([]);
  });

  it("a user message opens a turn with a UserMessage", () => {
    const thread = liveChatToThread([
      makeMessage({ id: "u1", role: "user", content: "hi there" }),
    ]);
    expect(thread.turns).toHaveLength(1);
    const msgs = thread.turns[0].messages;
    expect(msgs).toHaveLength(1);
    const um = msgs[0] as UserMessage;
    expect(um.type).toBe("user");
    expect(um.role).toBe("human");
    expect(um.label).toBe("You");
    expect(um.text).toBe("hi there");
    expect(um.evt).toBe("u1");
  });

  it("a user then assistant message land in the SAME turn", () => {
    const thread = liveChatToThread([
      makeMessage({ id: "u1", role: "user", content: "ping" }),
      makeMessage({ id: "a1", role: "assistant", content: "pong" }),
    ]);
    expect(thread.turns).toHaveLength(1);
    const msgs = thread.turns[0].messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0].type).toBe("user");
    const am = msgs[1] as AgentMessage;
    expect(am.type).toBe("agent");
    expect(am.speaker).toBe("Claude");
    expect(am.model).toBeUndefined();
    expect(am.prose).toBe("pong");
  });

  it("a leading assistant message opens its own turn", () => {
    const thread = liveChatToThread([
      makeMessage({ id: "a1", role: "assistant", content: "I started first" }),
    ]);
    expect(thread.turns).toHaveLength(1);
    const msgs = thread.turns[0].messages;
    expect(msgs).toHaveLength(1);
    const am = msgs[0] as AgentMessage;
    expect(am.type).toBe("agent");
    expect(am.prose).toBe("I started first");
  });

  it("maps pending → AgentMessage.streaming", () => {
    const thread = liveChatToThread([
      makeMessage({ id: "a1", role: "assistant", content: "...", pending: true }),
    ]);
    const am = thread.turns[0].messages[0] as AgentMessage;
    expect(am.streaming).toBe(true);
  });

  it("a message error appends a trailing ErrorMessage in the SAME turn", () => {
    const thread = liveChatToThread([
      makeMessage({
        id: "u1",
        role: "user",
        content: "boom",
        error: "session not found",
      }),
    ]);
    expect(thread.turns).toHaveLength(1);
    const msgs = thread.turns[0].messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0].type).toBe("user");
    const em = msgs[1] as ErrorMessage;
    expect(em.type).toBe("error");
    expect(em.title).toBe("Failed to send");
    expect(em.sub).toBe("session not found");
    expect(em.evt).toBe("u1-error");
  });

  it("an assistant error appends the ErrorMessage after the agent row", () => {
    const thread = liveChatToThread([
      makeMessage({ id: "u1", role: "user", content: "q" }),
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "partial",
        error: "stream dropped",
      }),
    ]);
    expect(thread.turns).toHaveLength(1);
    const msgs = thread.turns[0].messages;
    expect(msgs.map((m) => m.type)).toEqual(["user", "agent", "error"]);
  });

  it("two user messages produce two turns, preserving order", () => {
    const thread = liveChatToThread([
      makeMessage({ id: "u1", role: "user", content: "first" }),
      makeMessage({ id: "u2", role: "user", content: "second" }),
    ]);
    expect(thread.turns).toHaveLength(2);
    expect((thread.turns[0].messages[0] as UserMessage).text).toBe("first");
    expect((thread.turns[1].messages[0] as UserMessage).text).toBe("second");
  });

  it("preserves overall ordering across alternating roles", () => {
    const thread = liveChatToThread([
      makeMessage({ id: "u1", role: "user", content: "a" }),
      makeMessage({ id: "a1", role: "assistant", content: "b" }),
      makeMessage({ id: "u2", role: "user", content: "c" }),
      makeMessage({ id: "a2", role: "assistant", content: "d" }),
    ]);
    expect(thread.turns).toHaveLength(2);
    expect(thread.turns[0].messages.map((m) => m.type)).toEqual([
      "user",
      "agent",
    ]);
    expect(thread.turns[1].messages.map((m) => m.type)).toEqual([
      "user",
      "agent",
    ]);
    const texts = thread.turns.flatMap((t) =>
      t.messages.map((m) =>
        m.type === "user" ? m.text : m.type === "agent" ? m.prose : null
      )
    );
    expect(texts).toEqual(["a", "b", "c", "d"]);
  });

  it("a user message with content_format undefined still maps text", () => {
    const thread = liveChatToThread([makeMessage({ id: "u1", content: "x" })]);
    expect((thread.turns[0].messages[0] as UserMessage).text).toBe("x");
  });
});
