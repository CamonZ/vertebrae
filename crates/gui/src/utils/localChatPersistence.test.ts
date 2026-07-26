import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../stores/chatStore";
import {
  clearLastUsedLocalChatModelId,
  clearPersistedLocalChatSessions,
  findPersistedLocalChatSession,
  isLocalChatSessionCleared,
  loadLastUsedLocalChatModelId,
  listPersistedLocalChatSessions,
  loadPersistedLocalChatSession,
  loadPersistedLocalChatSessions,
  markLocalChatSessionCleared,
  normalizeLocalChatSession,
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
    backendSessionId: "backend-1",
    providerResumeId: "conv-1",
    projectPath: "/repo",
    selectedModelId: "opus",
    selectedReasoningEffort: "high",
    model: "claude-sonnet-4",
    tokenUsage: { used: 120, max: 200000 },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
    harness: overrides.harness ?? "claude",
  };
}

describe("localChatPersistence", () => {
  beforeEach(() => {
    localStorage.clear();
    clearPersistedLocalChatSessions();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips resumable local chat metadata", () => {
    persistLocalChatSession(
      makeSession({
        permissionMode: "auto",
        title: "Inferred Session Title",
        titleStatus: "generated",
        titleConfidence: 0.88,
        titleUserMessageCount: 2,
      })
    );

    const loaded = loadPersistedLocalChatSession("s-1");
    expect(loaded).toMatchObject({
      id: "s-1",
      label: "Task Chat",
      title: "Inferred Session Title",
      titleStatus: "generated",
      titleConfidence: 0.88,
      titleUserMessageCount: 2,
      status: "open",
      harness: "claude",
      backendSessionId: null,
      providerResumeId: "conv-1",
      projectPath: "/repo",
      selectedModelId: "opus",
      selectedReasoningEffort: "high",
      permissionMode: "auto",
      model: "claude-sonnet-4",
      tokenUsage: { used: 120, max: 200000 },
      lifecycle: "idle",
      lifecycleError: null,
      streamingAssistant: null,
    });
    expect(loaded?.messages).toEqual([]);
  });

  it("ignores old browser localStorage session records", () => {
    localStorage.setItem(
      "local-chat-sessions:v1",
      JSON.stringify({
        old: makeSession({ id: "old" }),
      })
    );

    expect(loadPersistedLocalChatSession("old")).toBeNull();
    expect(listPersistedLocalChatSessions()).toEqual([]);
  });

  it("finds a persisted session by project path", () => {
    persistLocalChatSession(
      makeSession({ id: "repo-a", projectPath: "/repo-a" })
    );
    persistLocalChatSession(
      makeSession({ id: "repo-b", projectPath: "/repo-b" })
    );

    expect(findPersistedLocalChatSession("/repo-b")?.id).toBe("repo-b");
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
      providerResumeId: "conv-1",
    });
  });

  it("drops closed empty sessions instead of listing unresumable history", () => {
    persistLocalChatSession(
      makeSession({
        messages: [],
        providerResumeId: null,
        lifecycle: "closed",
      })
    );

    expect(loadPersistedLocalChatSession("s-1")).toBeNull();
    expect(loadPersistedLocalChatSessions()).toEqual({});
    expect(listPersistedLocalChatSessions()).toEqual([]);
    expect(findPersistedLocalChatSession("/repo")).toBeNull();
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
      messages: [],
    });
  });

  it("retires pending user questions when restoring without a live backend", () => {
    const pendingQuestion = {
      kind: "user_question" as const,
      requestId: "req-1",
      toolUseId: "tool-1",
      questions: [],
      originalQuestions: [],
      status: "pending" as const,
      timestamp: "2026-01-01T00:00:01Z",
    };

    expect(
      normalizeLocalChatSession(makeSession({ messages: [pendingQuestion] }))
        ?.messages[0]
    ).toMatchObject({ kind: "user_question", status: "unavailable" });
  });

  it("ignores legacy task and chat handoff records", () => {
    localStorage.setItem(
      "task-stash:legacy",
      JSON.stringify({ taskId: "task-1", task: makeSession({ id: "task-1" }) })
    );
    localStorage.setItem(
      "chat-stash:legacy",
      JSON.stringify({ session: makeSession({ id: "chat-1" }) })
    );

    expect(loadPersistedLocalChatSession("task-1")).toBeNull();
    expect(loadPersistedLocalChatSession("chat-1")).toBeNull();
    expect(listPersistedLocalChatSessions()).toEqual([]);
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
        title: "Summarized Newer Task",
        titleStatus: "generated",
        titleConfidence: 0.9,
        titleUserMessageCount: 2,
        messages: [
          {
            kind: "assistant",
            text: "new answer",
            timestamp: "2026-01-02T00:00:00Z",
          },
        ],
        createdAt: "2026-01-01T12:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        providerResumeId: "conv-newer",
      })
    );

    expect(listPersistedLocalChatSessions("/repo")).toEqual([
      expect.objectContaining({
        id: "newer",
        label: "Newer Task",
        title: "Summarized Newer Task",
        titleStatus: "generated",
        titleConfidence: 0.9,
        titleUserMessageCount: 2,
        createdAt: "2026-01-01T12:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        projectPath: "/repo",
        providerResumeId: "conv-newer",
        messageCount: 1,
      }),
      expect.objectContaining({
        id: "older",
        messageCount: 1,
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

  it("stores message count metadata without transcript text", () => {
    persistLocalChatSession(
      makeSession({
        messages: [
          {
            kind: "warning",
            message: "permission needed",
            timestamp: "2026-01-01T00:00:00Z",
          },
        ],
      })
    );

    expect(listPersistedLocalChatSessions()[0]).toMatchObject({
      messageCount: 1,
    });
    expect(loadPersistedLocalChatSession("s-1")?.messages).toEqual([]);
  });

  it("keeps closed message-bearing sessions even when no provider id exists", () => {
    persistLocalChatSession(
      makeSession({
        providerResumeId: null,
        lifecycle: "closed",
      })
    );

    expect(loadPersistedLocalChatSession("s-1")).toMatchObject({
      lifecycle: "closed",
      providerResumeId: null,
      messageCount: 1,
      messages: [],
    });
  });

  it("merges existing app index entries before the first async save", async () => {
    vi.resetModules();
    const { commands: freshCommands } = await import("../bindings");
    const loadIndex = vi
      .spyOn(freshCommands, "loadLocalChatSessionIndex")
      .mockResolvedValue({
        status: "ok",
        data: [
          {
            id: "existing",
            label: "Existing",
            title: "Existing",
            titleStatus: "generated",
            titleConfidence: 0.9,
            titleUserMessageCount: 1,
            harness: "claude",
            model: null,
            selectedModelId: null,
            selectedReasoningEffort: null,
            permissionMode: "default",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            projectPath: "/repo",
            providerResumeId: "conv-existing",
            threadTotalTokens: null,
            messageCount: 1,
            lifecycle: "idle",
            status: "open",
          },
        ],
      });
    const saveIndex = vi
      .spyOn(freshCommands, "saveLocalChatSessionIndex")
      .mockResolvedValue({ status: "ok", data: null });
    const persistence = await import("./localChatPersistence");

    persistence.persistLocalChatSession(makeSession({ id: "new" }));

    await waitFor(() => expect(saveIndex).toHaveBeenCalled());
    expect(loadIndex).toHaveBeenCalled();
    const savedIds = saveIndex.mock.calls[0][0].sessions
      .map((session) => session.id)
      .sort();
    expect(savedIds).toEqual(["existing", "new"]);
  });

  it("scopes listed sessions by project path without treating no-project sessions as wildcards", () => {
    persistLocalChatSession(
      makeSession({ id: "repo-a", projectPath: "/repo-a" })
    );
    persistLocalChatSession(
      makeSession({ id: "repo-b", projectPath: "/repo-b" })
    );
    persistLocalChatSession(
      makeSession({ id: "no-project", projectPath: null })
    );

    expect(listPersistedLocalChatSessions("/repo-a").map((s) => s.id)).toEqual([
      "repo-a",
    ]);
    expect(listPersistedLocalChatSessions(null).map((s) => s.id)).toEqual([
      "no-project",
    ]);
  });

  it("does not reuse a no-project persisted session for a requested project path", () => {
    persistLocalChatSession(
      makeSession({ id: "no-project", projectPath: null })
    );

    expect(findPersistedLocalChatSession("/repo-a")).toBeNull();
  });

  it("reuses a no-project persisted session when the requested project path is null", () => {
    persistLocalChatSession(
      makeSession({ id: "no-project", projectPath: null })
    );

    expect(findPersistedLocalChatSession(null)?.id).toBe("no-project");
  });
});
