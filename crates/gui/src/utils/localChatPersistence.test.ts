import { beforeEach, describe, expect, it } from "vitest";
import type { ChatSession } from "../stores/chatStore";
import {
  findPersistedLocalChatSession,
  isLocalChatSessionCleared,
  loadPersistedLocalChatSession,
  loadPersistedLocalChatSessions,
  markLocalChatSessionCleared,
  persistLocalChatSession,
  removePersistedLocalChatSession,
} from "./localChatPersistence";

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "s-1",
    scope: "task",
    entityId: "task-1",
    label: "Task Chat",
    messages: [
      { kind: "user", text: "hello", timestamp: "2026-01-01T00:00:00Z" },
    ],
    status: "open",
    claudeSessionId: "backend-1",
    claudeConversationId: "conv-1",
    contextSummary: "[Context]",
    projectPath: "/repo",
    model: "claude-sonnet-4",
    tokenUsage: { used: 120, max: 200000 },
    isDetached: true,
    ...overrides,
  };
}

describe("localChatPersistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips resumable scoped chat metadata", () => {
    persistLocalChatSession(makeSession());

    const loaded = loadPersistedLocalChatSession("s-1");
    expect(loaded).toMatchObject({
      id: "s-1",
      scope: "task",
      entityId: "task-1",
      label: "Task Chat",
      status: "open",
      claudeSessionId: null,
      claudeConversationId: "conv-1",
      contextSummary: "[Context]",
      projectPath: "/repo",
      model: "claude-sonnet-4",
      tokenUsage: { used: 120, max: 200000 },
      isDetached: false,
      lifecycle: "idle",
      lifecycleError: null,
      streamingAssistant: null,
    });
    expect(loaded?.messages).toEqual([
      { kind: "user", text: "hello", timestamp: "2026-01-01T00:00:00Z" },
    ]);
  });

  it("finds a persisted session by scope, entity, and project path", () => {
    persistLocalChatSession(
      makeSession({ id: "repo-a", projectPath: "/repo-a" })
    );
    persistLocalChatSession(
      makeSession({ id: "repo-b", projectPath: "/repo-b" })
    );

    expect(findPersistedLocalChatSession("task", "task-1", "/repo-b")?.id).toBe(
      "repo-b"
    );
  });

  it("does not find closed sessions for scope reopen", () => {
    persistLocalChatSession(makeSession({ status: "closed" }));

    expect(findPersistedLocalChatSession("task", "task-1", "/repo")).toBeNull();
  });

  it("persists closed lifecycle as local resumable metadata", () => {
    persistLocalChatSession(makeSession({ lifecycle: "closed" }));

    expect(loadPersistedLocalChatSession("s-1")).toMatchObject({
      status: "open",
      lifecycle: "closed",
      claudeConversationId: "conv-1",
    });
  });

  it("strips ephemeral stream state and partial assistant messages", () => {
    persistLocalChatSession(
      makeSession({
        messages: [
          {
            kind: "user",
            text: "question",
            timestamp: "2026-01-01T00:00:00Z",
          },
          {
            kind: "assistant",
            text: "partial",
            timestamp: "2026-01-01T00:00:01Z",
            isPartial: true,
          },
        ],
        lifecycle: "streaming",
        streamingAssistant: {
          text: "partial overlay",
          timestamp: "2026-01-01T00:00:01Z",
        },
      })
    );

    expect(loadPersistedLocalChatSession("s-1")).toMatchObject({
      lifecycle: "idle",
      streamingAssistant: null,
      messages: [
        {
          kind: "user",
          text: "question",
          timestamp: "2026-01-01T00:00:00Z",
        },
      ],
    });
  });

  it("strips legacy persisted partial assistant messages during hydration", () => {
    localStorage.setItem(
      "local-chat-sessions:v1",
      JSON.stringify({
        "s-1": makeSession({
          messages: [
            {
              kind: "assistant",
              text: "legacy partial",
              timestamp: "2026-01-01T00:00:00Z",
              isPartial: true,
            },
            {
              kind: "assistant",
              text: "complete",
              timestamp: "2026-01-01T00:00:01Z",
              isPartial: false,
            },
          ],
        }),
      })
    );

    expect(loadPersistedLocalChatSession("s-1")?.messages).toMatchObject([
      {
        kind: "assistant",
        text: "complete",
        isPartial: false,
      },
    ]);
  });

  it("excludes closed sessions from startup hydration", () => {
    persistLocalChatSession(makeSession({ id: "open" }));
    persistLocalChatSession(makeSession({ id: "closed", status: "closed" }));

    expect(Object.keys(loadPersistedLocalChatSessions())).toEqual(["open"]);
    expect(loadPersistedLocalChatSession("closed")?.status).toBe("closed");
  });

  it("removes a persisted session explicitly", () => {
    persistLocalChatSession(makeSession());
    removePersistedLocalChatSession("s-1");

    expect(loadPersistedLocalChatSession("s-1")).toBeNull();
    expect(loadPersistedLocalChatSessions()).toEqual({});
  });

  it("tracks explicit clears and drops that marker on a new persist", () => {
    markLocalChatSessionCleared("s-1");
    expect(isLocalChatSessionCleared("s-1")).toBe(true);

    persistLocalChatSession(makeSession());

    expect(isLocalChatSessionCleared("s-1")).toBe(false);
  });
});
