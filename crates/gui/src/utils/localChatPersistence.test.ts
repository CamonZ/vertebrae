import { beforeEach, describe, expect, it } from "vitest";
import type { ChatSession } from "../stores/chatStore";
import {
  clearLastUsedLocalChatModelId,
  findPersistedLocalChatSession,
  isLocalChatSessionCleared,
  loadLastUsedLocalChatModelId,
  listPersistedLocalChatSessions,
  loadPersistedLocalChatSession,
  loadPersistedLocalChatSessions,
  markLocalChatSessionCleared,
  persistLastUsedLocalChatModelId,
  persistLocalChatSession,
  removePersistedLocalChatSession,
} from "./localChatPersistence";

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "s-1",
    label: "Task Chat",
    messages: [
      { kind: "user", text: "hello", timestamp: "2026-01-01T00:00:00Z" },
    ],
    status: "open",
    claudeSessionId: "backend-1",
    claudeConversationId: "conv-1",
    projectPath: "/repo",
    selectedModelId: "opus",
    model: "claude-sonnet-4",
    tokenUsage: { used: 120, max: 200000 },
    isDetached: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    preview: "hello",
    ...overrides,
  };
}

describe("localChatPersistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips resumable local chat metadata", () => {
    persistLocalChatSession(makeSession({ permissionMode: "auto" }));

    const loaded = loadPersistedLocalChatSession("s-1");
    expect(loaded).toMatchObject({
      id: "s-1",
      label: "Task Chat",
      status: "open",
      claudeSessionId: null,
      claudeConversationId: "conv-1",
      projectPath: "/repo",
      selectedModelId: "opus",
      permissionMode: "auto",
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

  it("loads legacy scoped v1 sessions while stripping scope fields", () => {
    localStorage.setItem(
      "local-chat-sessions:v1",
      JSON.stringify({
        legacy: {
          ...makeSession({ id: "legacy" }),
          scope: "task",
          entityId: "task-1",
          contextSummary: "[Context]",
        },
      })
    );

    const loaded = loadPersistedLocalChatSession("legacy");
    expect(loaded).toMatchObject({
      id: "legacy",
      label: "Task Chat",
      claudeConversationId: "conv-1",
    });
    expect(loaded && "scope" in loaded).toBe(false);
    expect(loaded && "entityId" in loaded).toBe(false);
    expect(loaded && "contextSummary" in loaded).toBe(false);
  });

  it("normalizes stale persisted permission modes to default", () => {
    localStorage.setItem(
      "local-chat-sessions:v1",
      JSON.stringify({
        "s-1": makeSession({
          permissionMode: "delegate" as ChatSession["permissionMode"],
        }),
      })
    );

    expect(loadPersistedLocalChatSession("s-1")?.permissionMode).toBe(
      "default"
    );
  });

  it("finds a persisted session by project path", () => {
    persistLocalChatSession(
      makeSession({ id: "repo-a", projectPath: "/repo-a" })
    );
    persistLocalChatSession(
      makeSession({ id: "repo-b", projectPath: "/repo-b" })
    );

    expect(findPersistedLocalChatSession("/repo-b")?.id).toBe(
      "repo-b"
    );
  });

  it("finds the newest persisted session for a project path", () => {
    persistLocalChatSession(
      makeSession({
        id: "older",
        projectPath: "/repo",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      })
    );
    persistLocalChatSession(
      makeSession({
        id: "newer",
        projectPath: "/repo",
        createdAt: "2026-01-02T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      })
    );

    expect(findPersistedLocalChatSession("/repo")?.id).toBe("newer");
  });

  it("does not find closed sessions for reopen", () => {
    persistLocalChatSession(makeSession({ status: "closed" }));

    expect(findPersistedLocalChatSession("/repo")).toBeNull();
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

  it("remembers the last used local chat model id", () => {
    persistLastUsedLocalChatModelId("haiku");

    expect(loadLastUsedLocalChatModelId()).toBe("haiku");
  });

  it("clears the last used local chat model id", () => {
    persistLastUsedLocalChatModelId("haiku");

    clearLastUsedLocalChatModelId();

    expect(loadLastUsedLocalChatModelId()).toBeNull();
  });

  it("lists session summaries newest first with local metadata", () => {
    persistLocalChatSession(
      makeSession({
        id: "older",
        label: "Older Task",
        messages: [
          {
            kind: "user",
            text: "old question",
            timestamp: "2026-01-01T00:00:00Z",
          },
        ],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      })
    );
    persistLocalChatSession(
      makeSession({
        id: "newer",
        label: "Newer Task",
        messages: [
          {
            kind: "assistant",
            text: "new answer",
            timestamp: "2026-01-02T00:00:00Z",
          },
        ],
        createdAt: "2026-01-01T12:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        claudeConversationId: "conv-newer",
      })
    );

    expect(listPersistedLocalChatSessions("/repo")).toEqual([
      expect.objectContaining({
        id: "newer",
        label: "Newer Task",
        preview: "new answer",
        createdAt: "2026-01-01T12:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        projectPath: "/repo",
        claudeConversationId: "conv-newer",
        messageCount: 1,
      }),
      expect.objectContaining({
        id: "older",
        preview: "old question",
      }),
    ]);
  });

  it("sorts mixed ISO timestamp precision by time rather than text", () => {
    persistLocalChatSession(
      makeSession({
        id: "without-millis",
        updatedAt: "2026-01-01T00:00:00Z",
      })
    );
    persistLocalChatSession(
      makeSession({
        id: "with-millis",
        updatedAt: "2026-01-01T00:00:00.999Z",
      })
    );

    expect(listPersistedLocalChatSessions().map((s) => s.id)).toEqual([
      "with-millis",
      "without-millis",
    ]);
  });

  it("uses warning messages as local session preview text", () => {
    persistLocalChatSession(
      makeSession({
        messages: [
          {
            kind: "warning",
            message: "permission needed",
            timestamp: "2026-01-01T00:00:00Z",
          },
        ],
        preview: undefined,
      })
    );

    expect(listPersistedLocalChatSessions()[0]).toMatchObject({
      preview: "permission needed",
    });
  });

  it("scopes listed sessions by project path without treating legacy unscoped sessions as wildcards", () => {
    persistLocalChatSession(
      makeSession({ id: "repo-a", projectPath: "/repo-a" })
    );
    persistLocalChatSession(
      makeSession({ id: "repo-b", projectPath: "/repo-b" })
    );
    persistLocalChatSession(makeSession({ id: "legacy", projectPath: null }));

    expect(listPersistedLocalChatSessions("/repo-a").map((s) => s.id)).toEqual([
      "repo-a",
    ]);
    expect(listPersistedLocalChatSessions(null).map((s) => s.id)).toEqual([
      "legacy",
    ]);
  });

  it("does not reuse a legacy persisted session for a requested project path", () => {
    persistLocalChatSession(makeSession({ id: "legacy", projectPath: null }));

    expect(
      findPersistedLocalChatSession("/repo-a")
    ).toBeNull();
  });

  it("reuses a no-project persisted session when the requested project path is null", () => {
    persistLocalChatSession(makeSession({ id: "legacy", projectPath: null }));

    expect(findPersistedLocalChatSession(null)?.id).toBe("legacy");
  });

  it("normalizes legacy array storage into session summaries", () => {
    localStorage.setItem(
      "local-chat-sessions:v1",
      JSON.stringify([
        makeSession({
          id: "legacy-array",
          messages: [
            {
              kind: "user",
              text: "legacy text",
              timestamp: "2026-02-03T04:05:06Z",
            },
          ],
          createdAt: undefined,
          updatedAt: undefined,
          preview: undefined,
        }),
        { id: "bad", scope: "task", messages: [] },
      ])
    );

    expect(listPersistedLocalChatSessions()).toEqual([
      expect.objectContaining({
        id: "legacy-array",
        preview: "legacy text",
        createdAt: "2026-02-03T04:05:06Z",
        updatedAt: "2026-02-03T04:05:06Z",
      }),
    ]);
  });

  it("strips stale backend session ids from raw legacy storage", () => {
    localStorage.setItem(
      "local-chat-sessions:v1",
      JSON.stringify({
        legacy: makeSession({
          id: "legacy",
          claudeSessionId: "stale-backend-session",
          claudeConversationId: "conv-legacy",
        }),
      })
    );

    expect(loadPersistedLocalChatSession("legacy")).toMatchObject({
      claudeSessionId: null,
      claudeConversationId: "conv-legacy",
    });
  });

  it("treats corrupt storage as an empty local session index", () => {
    localStorage.setItem("local-chat-sessions:v1", "{not json");

    expect(listPersistedLocalChatSessions()).toEqual([]);
    expect(loadPersistedLocalChatSessions()).toEqual({});
  });
});
