import { flattenLocalChatTicketGroups, groupLocalChatSessionsByHierarchy } from "./localChatSessionGroups";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../stores/chatStore";
import {
  summarizeLocalChatSession,
  clearLastUsedLocalChatModelId,
  clearPersistedLocalChatSessions,
  findPersistedDefaultEmptyLocalChatSession,
  findPersistedGateChatSession,
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
    selectedSpeedTier: "fast",
    selectedPersonality: "Explanatory",
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

  it("retains activity without replaying a busy runtime from persisted metadata", async () => {
    await persistLocalChatSession(makeSession({ lifecycle: "streaming" }));
    const persisted = loadPersistedLocalChatSession("s-1");
    expect(persisted?.activityStatus).toBe("working");
    expect(persisted?.lifecycle).toBe("idle");
    expect(normalizeLocalChatSession(persisted)?.activityStatus).toBe(
      "working"
    );
    expect(normalizeLocalChatSession(persisted)?.backendSessionId).toBeNull();
  });

  it("persists only captured discussions and excludes them from conversation lookups", async () => {
    vi.resetModules();
    const { commands } = await import("../bindings");
    vi.spyOn(commands, "loadLocalChatSessionIndex").mockResolvedValue({ status: "ok", data: [] });
    const save = vi.spyOn(commands, "saveLocalChatSessionIndex")
      .mockResolvedValue({ status: "ok", data: null });
    const persistence = await import("./localChatPersistence");
    const discussionBinding = {
      parentChatId: "s-1",
      worktreePath: "/checkout",
      reviewThreadId: "b8c10d15-8f68-43a8-a527-f6243d663cb2",
    };
    const association = { ticketId: "shared-task", entityLevel: "task" };
    await persistence.persistLocalChatSession(makeSession({ association }));
    await persistence.persistLocalChatSession(makeSession({ id: "unbound", discussion: "unbound" }));
    await persistence.persistLocalChatSession(makeSession({
      id: "bound",
      discussion: discussionBinding,
      association,
      updatedAt: "2026-01-02T00:00:00Z",
    }));

    const saved = save.mock.lastCall?.[0].sessions ?? [];
    expect(saved.map(({ id }) => id)).toEqual(["s-1", "bound"]);
    const bound = saved.find(({ id }) => id === "bound");
    expect(bound?.discussionBinding).toEqual(discussionBinding);
    expect(persistence.normalizeLocalChatSession(bound))
      .toMatchObject({ discussion: discussionBinding, providerResumeId: "conv-1" });
    expect(persistence.listPersistedLocalChatSessions("/repo").map(({ id }) => id)).toEqual(["s-1"]);
    const groups = groupLocalChatSessionsByHierarchy(persistence.listPersistedLocalChatSessions("/repo"), new Map());
    expect(flattenLocalChatTicketGroups(groups).flatMap(({ sessions }) => sessions.map(({ id }) => id)))
      .toEqual(["s-1"]);
    expect(persistence.findPersistedLocalChatSession("/repo")?.id).toBe("s-1");
    expect(persistence.loadPersistedLocalChatSession("bound")).toBeNull();
    expect(Object.keys(persistence.loadPersistedLocalChatSessions())).toEqual(["s-1"]);
  });

  it("never sends an unbound discussion to the session index command", async () => {
    vi.resetModules();
    const { commands } = await import("../bindings");
    vi.spyOn(commands, "loadLocalChatSessionIndex").mockResolvedValue({ status: "ok", data: [] });
    const save = vi.spyOn(commands, "saveLocalChatSessionIndex")
      .mockResolvedValue({ status: "ok", data: null });
    const persistence = await import("./localChatPersistence");

    await persistence.persistLocalChatSession(makeSession({ id: "unbound", discussion: "unbound" }));
    expect(save).not.toHaveBeenCalled();
    await persistence.persistLocalChatSession(makeSession({ id: "main" }));
    expect(save.mock.calls[0][0].changedIds).toEqual(["main"]);
    expect(save.mock.calls[0][0].sessions.map(({ id }) => id)).toEqual(["main"]);
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
      hasUserMessage: true,
      status: "open",
      harness: "claude",
      backendSessionId: null,
      providerResumeId: "conv-1",
      projectPath: "/repo",
      selectedModelId: "opus",
      selectedReasoningEffort: "high",
      selectedSpeedTier: "fast",
      selectedPersonality: "Explanatory",
      permissionMode: "auto",
      model: "claude-sonnet-4",
      tokenUsage: { used: 120, max: 200000 },
      lifecycle: "idle",
      lifecycleError: null,
      streamingAssistant: null,
    });
    expect(loaded?.messages).toEqual([]);
  });

  it("keeps untouched sessions out of history until the first user message", () => {
    persistLocalChatSession(
      makeSession({
        id: "untouched",
        messages: [],
        messageCount: 0,
        providerResumeId: null,
        hasUserMessage: false,
      })
    );

    expect(loadPersistedLocalChatSession("untouched")).toMatchObject({
      hasUserMessage: false,
    });
    expect(listPersistedLocalChatSessions()).toEqual([]);

    persistLocalChatSession(
      makeSession({
        id: "untouched",
        messages: [
          { kind: "user", text: "hello", timestamp: "2026-01-01T00:00:00Z" },
        ],
        messageCount: 1,
        providerResumeId: null,
        hasUserMessage: true,
      })
    );

    expect(
      listPersistedLocalChatSessions().map((session) => session.id)
    ).toEqual(["untouched"]);
  });

  it("loads legacy sessions without a speed tier", () => {
    const legacy = makeSession();
    delete (legacy as Partial<ChatSession>).selectedSpeedTier;

    const normalized = normalizeLocalChatSession(legacy);
    expect(normalized?.selectedSpeedTier).toBeUndefined();
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

  it("reconciles remote removal while preserving an edit and deletion racing refresh", async () => {
    vi.resetModules();
    const { commands: freshCommands } = await import("../bindings");
    const load = vi.spyOn(freshCommands, "loadLocalChatSessionIndex");
    load.mockResolvedValue({ status: "ok", data: [] });
    vi.spyOn(freshCommands, "saveLocalChatSessionIndex").mockResolvedValue({
      status: "ok",
      data: null,
    });
    const persistence = await import("./localChatPersistence");
    await persistence.hydrateLocalChatSessionIndex();
    await persistence.persistLocalChatSession(makeSession({ id: "edited" }));
    await persistence.persistLocalChatSession(makeSession({ id: "deleted" }));
    await persistence.persistLocalChatSession(
      makeSession({ id: "remote-deleted" })
    );

    let deliver!: (
      value: Awaited<ReturnType<typeof freshCommands.loadLocalChatSessionIndex>>
    ) => void;
    load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        })
    );

    const refresh = persistence.refreshLocalChatSessionIndex(() => true);
    await waitFor(() => expect(deliver).toBeTypeOf("function"));

    await persistence.persistLocalChatSession(
      makeSession({ id: "edited", title: "Manual correction" })
    );
    persistence.removePersistedLocalChatSession("deleted");

    // The transport returns an older snapshot containing the locally deleted chat.
    deliver({
      status: "ok",
      data: [
        makeSession({ id: "deleted" }),
        makeSession({ id: "edited", title: "Old" }),
      ],
    } as never);
    await refresh;

    expect(persistence.loadPersistedLocalChatSession("edited")?.title).toBe(
      "Manual correction"
    );
    expect(persistence.loadPersistedLocalChatSession("deleted")).toBeNull();
    expect(
      persistence.loadPersistedLocalChatSession("remote-deleted")
    ).toBeNull();
  });

  it("drops a snapshot whose project scope retired during the read", async () => {
    vi.resetModules();
    const { commands: freshCommands } = await import("../bindings");
    const load = vi
      .spyOn(freshCommands, "loadLocalChatSessionIndex")
      .mockResolvedValue({ status: "ok", data: [] });
    const persistence = await import("./localChatPersistence");
    await persistence.hydrateLocalChatSessionIndex();

    let current = true;
    load.mockImplementationOnce(async () => {
      current = false;
      return {
        status: "ok",
        data: [makeSession({ id: "old-project" })],
      } as never;
    });
    expect(
      await persistence.refreshLocalChatSessionIndex(() => current)
    ).toBeNull();
    expect(persistence.loadPersistedLocalChatSession("old-project")).toBeNull();
  });

  it("saves explicit edits and deletions without treating untouched snapshot rows as edits", async () => {
    vi.resetModules();
    const { commands: freshCommands } = await import("../bindings");
    vi.spyOn(freshCommands, "loadLocalChatSessionIndex").mockResolvedValue({
      status: "ok",
      data: [],
    });
    const save = vi
      .spyOn(freshCommands, "saveLocalChatSessionIndex")
      .mockResolvedValue({ status: "ok", data: null });
    const persistence = await import("./localChatPersistence");
    await persistence.hydrateLocalChatSessionIndex();
    await persistence.persistLocalChatSession(makeSession({ id: "untouched" }));
    await persistence.persistLocalChatSession(makeSession({ id: "edited" }));

    save.mockClear();

    await persistence.persistLocalChatSession(
      makeSession({ id: "edited", title: "Correction" })
    );
    expect(save.mock.calls[0][0].changedIds).toEqual(["edited"]);
    expect(save.mock.calls[0][0].sessions.map((s) => s.id)).toEqual([
      "untouched",
      "edited",
    ]);

    save.mockClear();
    persistence.removePersistedLocalChatSession("edited");
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0].deletedIds).toEqual(["edited"]);
    expect(save.mock.calls[0][0].changedIds).toEqual([]);
  });

  it("retains a second edit while the first edit is awaiting durable acknowledgement", async () => {
    vi.resetModules();
    const { commands: freshCommands } = await import("../bindings");
    vi.spyOn(freshCommands, "loadLocalChatSessionIndex").mockResolvedValue({
      status: "ok",
      data: [],
    });
    const save = vi
      .spyOn(freshCommands, "saveLocalChatSessionIndex")
      .mockResolvedValue({ status: "ok", data: null });
    const persistence = await import("./localChatPersistence");
    await persistence.hydrateLocalChatSessionIndex();

    let acknowledge!: () => void;
    save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = () => resolve({ status: "ok", data: null });
        })
    );

    const first = persistence.persistLocalChatSession(
      makeSession({ id: "edited", title: "First" })
    );
    await waitFor(() => expect(acknowledge).toBeTypeOf("function"));
    const second = persistence.persistLocalChatSession(
      makeSession({ id: "edited", title: "Second" })
    );

    acknowledge();
    await Promise.all([first, second]);

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0].changedIds).toEqual(["edited"]);
    expect(save.mock.calls[1][0].sessions[0].title).toBe("Second");
  });

  it("issues no index write when only usage, lifecycle or partial text change", async () => {
    vi.resetModules();
    const { commands: freshCommands } = await import("../bindings");
    vi.spyOn(freshCommands, "loadLocalChatSessionIndex").mockResolvedValue({
      status: "ok",
      data: [],
    });
    const save = vi
      .spyOn(freshCommands, "saveLocalChatSessionIndex")
      .mockResolvedValue({ status: "ok", data: null });
    const persistence = await import("./localChatPersistence");
    await persistence.hydrateLocalChatSessionIndex();
    const base = makeSession({ id: "streaming", messageCount: 1 });
    await persistence.persistLocalChatSession(base);
    save.mockClear();

    for (let used = 1; used <= 20; used++) {
      await persistence.persistLocalChatSession({
        ...base,
        tokenUsage: { used, max: 200000 },
      });
    }
    expect(
      persistence.loadPersistedLocalChatSession("streaming")?.tokenUsage
    ).toEqual({ used: 20, max: 200000 });
    await persistence.persistLocalChatSession({ ...base, lifecycle: "error" });
    await persistence.persistLocalChatSession({
      ...base,
      messages: [
        ...base.messages,
        { kind: "assistant", text: "par", isPartial: true },
      ] as ChatSession["messages"],
    });

    expect(save).not.toHaveBeenCalled();

    // A changed persisted field still produces exactly one targeted write.
    await persistence.persistLocalChatSession({ ...base, title: "Renamed" });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].changedIds).toEqual(["streaming"]);
  });

  it("applies merged remote entries unless a local edit or deletion is pending", async () => {
    vi.resetModules();
    const { commands: freshCommands } = await import("../bindings");
    vi.spyOn(freshCommands, "loadLocalChatSessionIndex").mockResolvedValue({
      status: "ok",
      data: [],
    });
    const save = vi
      .spyOn(freshCommands, "saveLocalChatSessionIndex")
      .mockResolvedValue({ status: "ok", data: null });
    const persistence = await import("./localChatPersistence");

    // Before hydration, startup recovery reads the already merged entry.
    expect(
      persistence.applyRemoteLocalChatSession("remote", makeSession())
    ).toBeUndefined();
    await persistence.hydrateLocalChatSessionIndex();

    const applied = persistence.applyRemoteLocalChatSession(
      "remote",
      makeSession({ id: "remote", title: "From catalog" })
    );
    expect(applied?.title).toBe("From catalog");
    expect(persistence.loadPersistedLocalChatSession("remote")?.title).toBe(
      "From catalog"
    );
    expect(save).not.toHaveBeenCalled();

    let acknowledge!: () => void;
    save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = () => resolve({ status: "ok", data: null });
        })
    );
    const edit = persistence.persistLocalChatSession(
      makeSession({ id: "remote", title: "Local edit" })
    );
    await waitFor(() => expect(acknowledge).toBeTypeOf("function"));
    expect(
      persistence.applyRemoteLocalChatSession(
        "remote",
        makeSession({ id: "remote", title: "Stale remote" })
      )
    ).toBeUndefined();
    acknowledge();
    await edit;
    expect(persistence.loadPersistedLocalChatSession("remote")?.title).toBe(
      "Local edit"
    );

    expect(persistence.applyRemoteLocalChatSession("remote", null)).toBeNull();
    expect(persistence.loadPersistedLocalChatSession("remote")).toBeNull();
    expect(
      persistence.applyRemoteLocalChatSession("remote", null)
    ).toBeUndefined();
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
            selectedPersonality: null,
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

  it("deduplicates automatic empty entries loaded from the app index", async () => {
    vi.resetModules();
    const { commands: freshCommands } = await import("../bindings");
    vi.spyOn(freshCommands, "loadLocalChatSessionIndex").mockResolvedValue({
      status: "ok",
      data: [
        {
          id: "loaded-empty",
          label: "New Chat",
          title: null,
          titleStatus: "pending",
          titleConfidence: null,
          titleUserMessageCount: 0,
          harness: "claude",
          model: null,
          selectedModelId: null,
          selectedReasoningEffort: null,
          selectedPersonality: null,
          permissionMode: "default",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          projectPath: "/repo",
          providerResumeId: null,
          threadTotalTokens: null,
          messageCount: 0,
          lifecycle: "idle",
          status: "open",
        },
      ],
    });
    const saveIndex = vi
      .spyOn(freshCommands, "saveLocalChatSessionIndex")
      .mockResolvedValue({ status: "ok", data: null });
    const persistence = await import("./localChatPersistence");

    persistence.persistLocalChatSession(
      makeSession({
        id: "new-empty",
        label: "New Chat",
        messages: [],
        messageCount: 0,
        providerResumeId: null,
        projectPath: "/repo",
        createdAt: "2026-01-02T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      })
    );

    await waitFor(() => expect(saveIndex).toHaveBeenCalled());
    const savedIds = saveIndex.mock.calls[
      saveIndex.mock.calls.length - 1
    ]?.[0].sessions.map((session) => session.id);
    expect(savedIds).toContain("new-empty");
    expect(savedIds).not.toContain("loaded-empty");
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

  it("deduplicates automatic empty sessions without deleting durable sessions", () => {
    persistLocalChatSession(
      makeSession({
        id: "empty-old",
        label: "New Chat",
        messages: [],
        messageCount: 0,
        providerResumeId: null,
        projectPath: "/repo",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      })
    );
    persistLocalChatSession(
      makeSession({
        id: "durable",
        projectPath: "/repo",
        updatedAt: "2026-01-02T00:00:00Z",
      })
    );
    persistLocalChatSession(
      makeSession({
        id: "empty-new",
        label: "New Chat",
        messages: [],
        messageCount: 0,
        providerResumeId: null,
        projectPath: "/repo",
        createdAt: "2026-01-03T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
      })
    );

    expect(loadPersistedLocalChatSession("empty-old")).toBeNull();
    expect(loadPersistedLocalChatSession("empty-new")).not.toBeNull();
    expect(loadPersistedLocalChatSession("durable")).not.toBeNull();
    expect(findPersistedDefaultEmptyLocalChatSession("/repo")?.id).toBe(
      "empty-new"
    );
  });

  it("does not treat explicitly named empty sessions as automatic placeholders", () => {
    persistLocalChatSession(
      makeSession({
        id: "scratch",
        label: "Scratchpad",
        messages: [],
        messageCount: 0,
        providerResumeId: null,
        projectPath: "/repo",
      })
    );
    persistLocalChatSession(
      makeSession({
        id: "default",
        label: "New Chat",
        messages: [],
        messageCount: 0,
        providerResumeId: null,
        projectPath: "/repo",
      })
    );

    expect(loadPersistedLocalChatSession("scratch")).not.toBeNull();
    expect(findPersistedDefaultEmptyLocalChatSession("/repo")?.id).toBe(
      "default"
    );
  });

  describe("gate bindings", () => {
    const gate = {
      task_run_id: "run-1",
      step_name: "approve",
      execution_id: "exec-1",
      artifact: "approval",
      role: null,
      question: "Ship v2?",
      output_schema: { type: "object" },
    };

    it("round-trips a gate chat's binding", () => {
      persistLocalChatSession(makeSession({ id: "gate-chat", gate }));

      expect(loadPersistedLocalChatSession("gate-chat")?.gate).toEqual(gate);
      expect(
        normalizeLocalChatSession({ ...makeSession(), gate })?.gate
      ).toEqual(gate);
    });

    it("drops bindings missing an identifying field", () => {
      for (const field of [
        "task_run_id",
        "step_name",
        "execution_id",
        "artifact",
      ]) {
        const broken = { ...gate, [field]: "" };
        expect(
          normalizeLocalChatSession({ ...makeSession(), gate: broken })?.gate
        ).toBeNull();
      }
      expect(normalizeLocalChatSession(makeSession())?.gate).toBeNull();
    });

    it("finds the newest open chat bound to a run's step", () => {
      persistLocalChatSession(
        makeSession({ id: "older", gate, updatedAt: "2026-01-01T00:00:00Z" })
      );
      persistLocalChatSession(
        makeSession({
          id: "newer",
          gate: { ...gate, execution_id: "exec-2" },
          updatedAt: "2026-02-01T00:00:00Z",
        })
      );
      persistLocalChatSession(
        makeSession({ id: "closed", gate, status: "closed" })
      );
      persistLocalChatSession(
        makeSession({ id: "other-step", gate: { ...gate, step_name: "x" } })
      );

      expect(findPersistedGateChatSession(gate)?.id).toBe("newer");
      expect(
        findPersistedGateChatSession({ ...gate, task_run_id: "run-2" })
      ).toBeNull();
    });
  });
});

it("projects each conversation's bound associations into its sidebar summary", () => {
  const association = {
    ticketId: "4694275d-ab38-423a-9e3e-17d8316cd070",
    ticketTitle: "Declutter chat headers",
    worktreePath: "/repo/worktree",
    branch: "feature",
  };
  expect(
    summarizeLocalChatSession(makeSession({ association })).association
  ).toEqual(association);
  expect(
    summarizeLocalChatSession(makeSession({ association: null })).association
  ).toBeNull();
  expect(summarizeLocalChatSession(makeSession()).association).toBeNull();
});
