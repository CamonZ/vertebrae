import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useChatStore } from "./chatStore";
import {
  clearPersistedLocalChatSessions,
  isLocalChatSessionCleared,
  loadPersistedLocalChatSession,
  persistLocalChatSession,
} from "../utils/localChatPersistence";
import { commands } from "../bindings";

describe("chatStore", () => {
  beforeEach(() => {
    localStorage.clear();
    clearPersistedLocalChatSessions();
    // Reset store to initial state
    useChatStore.setState({
      sessions: {},
      activeSessionId: null,
      paneLayout: { panes: [], activePaneId: null },
      panelOpen: false,
      localSessionSummaries: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("openSession", () => {
    it("creates a new neutral local chat session", () => {
      const id = useChatStore.getState().openSession("My Task");

      expect(id).toBeTruthy();
      const session = useChatStore.getState().sessions[id];
      expect(session).toBeDefined();
      expect(session.label).toBe("My Task");
      expect("scope" in session).toBe(false);
      expect("entityId" in session).toBe(false);
      expect(session.messages).toEqual([]);
      expect(session.status).toBe("open");
      expect(session.backendSessionId).toBeNull();
      expect(session.lifecycle).toBe("idle");
      expect(session.streamingAssistant).toBeNull();
      expect(session.title).toBeNull();
      expect(session.titleStatus).toBe("pending");
      expect(session.titleConfidence).toBeNull();
      expect(session.titleUserMessageCount).toBe(0);
    });

    it("sets the new session as active and opens the panel", () => {
      const id = useChatStore.getState().openSession("Workflow 1");

      expect(useChatStore.getState().activeSessionId).toBe(id);
      expect(useChatStore.getState().panelOpen).toBe(true);
    });

    it("reuses an existing session for the same project path", () => {
      const id1 = useChatStore.getState().openSession("Task A", "/repo/root");
      const id2 = useChatStore
        .getState()
        .openSession("Replacement Label", "/repo/root");

      expect(id1).toBe(id2);
      expect(Object.keys(useChatStore.getState().sessions)).toHaveLength(1);
    });

    it("reuses the newest open session for the same project path", () => {
      useChatStore.setState({
        sessions: {
          older: {
            id: "older",
            label: "Older",
            messages: [],
            status: "open",
            harness: "claude",
            backendSessionId: null,
            providerResumeId: "conv-older",
            projectPath: "/repo/root",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
          newer: {
            id: "newer",
            label: "Newer",
            messages: [],
            status: "open",
            harness: "claude",
            backendSessionId: null,
            providerResumeId: "conv-newer",
            projectPath: "/repo/root",
            createdAt: "2026-01-02T00:00:00Z",
            updatedAt: "2026-01-02T00:00:00Z",
          },
        },
        activeSessionId: null,
        panelOpen: false,
      });

      const reopened = useChatStore
        .getState()
        .openSession("New Chat", "/repo/root");

      expect(reopened).toBe("newer");
      expect(useChatStore.getState().activeSessionId).toBe("newer");
    });

    it("reusing session sets it as active and opens panel", () => {
      const id1 = useChatStore.getState().openSession("T1");
      useChatStore.getState().openSession("T2");

      // Close panel manually
      useChatStore.getState().setPanelOpen(false);
      expect(useChatStore.getState().panelOpen).toBe(false);

      // Reopen same session
      useChatStore.getState().openSession("T1");
      expect(useChatStore.getState().activeSessionId).toBe(id1);
      expect(useChatStore.getState().panelOpen).toBe(true);
    });

    it("creates separate sessions for different project paths", () => {
      const id1 = useChatStore.getState().openSession("Task 1", "/repo-a");
      const id2 = useChatStore.getState().openSession("Task 2", "/repo-b");

      expect(id1).not.toBe(id2);
      expect(Object.keys(useChatStore.getState().sessions)).toHaveLength(2);
    });

    it("persists sessions without scope or entity fields", () => {
      const id = useChatStore.getState().openSession("New Chat");

      const session = useChatStore.getState().sessions[id];
      const persisted = loadPersistedLocalChatSession(id);
      expect("scope" in session).toBe(false);
      expect("entityId" in session).toBe(false);
      expect(persisted && "scope" in persisted).toBe(false);
      expect(persisted && "entityId" in persisted).toBe(false);
    });

    it("stores the project path captured when the session is opened", () => {
      const id = useChatStore.getState().openSession("New Chat", "/repo/root");

      expect(useChatStore.getState().sessions[id].projectPath).toBe(
        "/repo/root"
      );
    });

    it("hydrates a persisted session for the same project path", () => {
      const id = useChatStore.getState().openSession("Task One", "/repo/root");
      useChatStore.getState().addMessage(id, {
        kind: "user",
        text: "remember this",
        timestamp: "2026-01-01T00:00:00Z",
      });
      useChatStore.getState().setBackendSessionId(id, "backend-1");
      useChatStore.getState().setProviderResumeId(id, "conv-1");
      useChatStore.getState().setSessionSelectedModel(id, "opus");
      useChatStore.getState().setSessionReasoningEffort(id, "high");
      useChatStore
        .getState()
        .setSessionUsage(id, "claude-sonnet-4", { used: 50, max: 200000 });

      useChatStore.setState({
        sessions: {},
        activeSessionId: null,
        panelOpen: false,
      });

      const reopened = useChatStore
        .getState()
        .openSession("Replacement Label", "/repo/root");

      expect(reopened).toBe(id);
      expect(useChatStore.getState().activeSessionId).toBe(id);
      expect(useChatStore.getState().panelOpen).toBe(true);
      expect(useChatStore.getState().sessions[id]).toMatchObject({
        label: "Task One",
        projectPath: "/repo/root",
        backendSessionId: null,
        providerResumeId: "conv-1",
        selectedModelId: "opus",
        selectedReasoningEffort: "high",
        model: "claude-sonnet-4",
        tokenUsage: { used: 50, max: 200000 },
      });
      expect(useChatStore.getState().sessions[id].messages).toEqual([]);
    });

    it("replays normalized provider events when reopening a persisted session", async () => {
      const id = useChatStore.getState().openSession("Task Replay", "/repo/root");
      useChatStore.getState().setProviderResumeId(id, "conv-replay");
      useChatStore.setState({
        sessions: {},
        activeSessionId: null,
        panelOpen: false,
      });
      const replay = vi
        .spyOn(commands, "loadLocalChatSessionReplay")
        .mockResolvedValue({
          status: "ok",
          data: {
            events: [
              JSON.stringify({
                version: 1,
                event_id: "event-1",
                stream_id: "local-replay/session",
                sequence: 1,
                correlation: { session_id: "conv-replay" },
                timestamp: "2026-01-01T00:00:00Z",
                semantics: "snapshot",
                type: "session_started",
                data: {
                  provider: "anthropic",
                  model: "sonnet",
                  provider_resume_id: "conv-replay",
                  tools: [],
                },
              }),
              JSON.stringify({
                version: 1,
                event_id: "event-2",
                stream_id: "local-replay/session",
                sequence: 2,
                correlation: { session_id: "conv-replay", thread_id: "conv-replay" },
                timestamp: "2026-01-01T00:00:01Z",
                semantics: "snapshot",
                type: "turn_input",
                data: {
                  thread_id: "conv-replay",
                  content: "remember this",
                  provenance: "human",
                },
              }),
              JSON.stringify({
                version: 1,
                event_id: "event-3",
                stream_id: "local-replay/session",
                sequence: 3,
                correlation: { session_id: "conv-replay", thread_id: "conv-replay" },
                timestamp: "2026-01-01T00:00:02Z",
                semantics: "snapshot",
                type: "text",
                data: { text: "welcome back" },
              }),
            ],
          },
        });

      const reopened = useChatStore
        .getState()
        .openSession("Replacement Label", "/repo/root");
      expect(reopened).toBe(id);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(replay).toHaveBeenCalledWith({
        session_id: id,
        harness: "claude",
        provider_resume_id: "conv-replay",
        project_path: "/repo/root",
        created_at: expect.any(String),
      });
      expect(useChatStore.getState().sessions[id].messages).toEqual([
        {
          kind: "session_start",
          model: "sonnet",
          timestamp: "2026-01-01T00:00:00Z",
        },
        {
          kind: "user",
          text: "remember this",
          timestamp: "2026-01-01T00:00:01Z",
        },
        {
          kind: "assistant",
          text: "welcome back",
          timestamp: "2026-01-01T00:00:02Z",
        },
      ]);
    });

    it("persists selected model and records it as the last used model", () => {
      const id = useChatStore.getState().openSession("Task Model");

      useChatStore.getState().setSessionSelectedModel(id, "haiku");

      expect(useChatStore.getState().sessions[id].selectedModelId).toBe(
        "haiku"
      );
      expect(loadPersistedLocalChatSession(id)?.selectedModelId).toBe("haiku");
      expect(localStorage.getItem("local-chat-model:last-used:v1")).toBe(
        "haiku"
      );
    });

    it("clears the last used model when selection returns to CLI default", () => {
      const id = useChatStore.getState().openSession("Task Model");

      useChatStore.getState().setSessionSelectedModel(id, "haiku");
      useChatStore.getState().setSessionSelectedModel(id, null);

      expect(useChatStore.getState().sessions[id].selectedModelId).toBeNull();
      expect(loadPersistedLocalChatSession(id)?.selectedModelId).toBeNull();
      expect(localStorage.getItem("local-chat-model:last-used:v1")).toBeNull();
    });

    it("stores selected harness before start and clears provider-specific model state", () => {
      const id = useChatStore.getState().openSession("Task Provider");

      useChatStore.getState().setSessionSelectedModel(id, "sonnet");
      useChatStore.getState().setSessionReasoningEffort(id, "high");
      useChatStore.getState().setSessionPermissionMode(id, "plan");
      useChatStore.getState().setSessionModel(id, "claude-sonnet");
      useChatStore.getState().setSessionTokenUsage(id, { used: 10, max: 100 });
      useChatStore.getState().setSessionHarness(id, "codex");

      expect(useChatStore.getState().sessions[id]).toMatchObject({
        harness: "codex",
        selectedModelId: undefined,
        selectedReasoningEffort: undefined,
        permissionMode: "default",
        model: undefined,
        tokenUsage: undefined,
      });
      expect(loadPersistedLocalChatSession(id)?.harness).toBe("codex");
      expect(localStorage.getItem("local-chat-model:last-used:v1")).toBeNull();
    });

    it("locks harness changes after a backend or provider resume id exists", () => {
      const backendId = useChatStore.getState().openSession("Task Backend");
      useChatStore.getState().setBackendSessionId(backendId, "backend-1");
      useChatStore.getState().setSessionHarness(backendId, "codex");

      expect(useChatStore.getState().sessions[backendId].harness).toBe(
        "claude"
      );

      const resumeId = useChatStore.getState().startFreshSession("Task Resume");
      useChatStore.getState().setProviderResumeId(resumeId, "resume-1");
      useChatStore.getState().setSessionHarness(resumeId, "codex");

      expect(useChatStore.getState().sessions[resumeId].harness).toBe("claude");
    });

    it("reuses the matching project path when persisted sessions are already loaded", () => {
      useChatStore.setState({
        sessions: {
          "repo-a": {
            id: "repo-a",
            label: "Repo A",
            messages: [],
            status: "open",
            harness: "claude",
            backendSessionId: null,
            providerResumeId: "conv-a",
            projectPath: "/repo-a",
          },
          "repo-b": {
            id: "repo-b",
            label: "Repo B",
            messages: [],
            status: "open",
            harness: "claude",
            backendSessionId: null,
            providerResumeId: "conv-b",
            projectPath: "/repo-b",
          },
        },
        activeSessionId: null,
        panelOpen: false,
      });

      const reopened = useChatStore.getState().openSession("Repo B", "/repo-b");

      expect(reopened).toBe("repo-b");
      expect(useChatStore.getState().sessions[reopened].label).toBe("Repo B");
    });

    it("does not reuse an in-memory unscoped session for a requested project path", () => {
      useChatStore.setState({
        sessions: {
          noProject: {
            id: "noProject",
            label: "No Project",
            messages: [],
            status: "open",
            harness: "claude",
            backendSessionId: null,
            providerResumeId: "conv-no-project",
            projectPath: null,
          },
        },
        activeSessionId: null,
        panelOpen: false,
      });

      const opened = useChatStore.getState().openSession("Repo A", "/repo-a");

      expect(opened).not.toBe("noProject");
      expect(useChatStore.getState().sessions[opened]).toMatchObject({
        label: "Repo A",
        projectPath: "/repo-a",
        providerResumeId: null,
      });
    });

    it("reuses an in-memory no-project session when the requested project path is null", () => {
      useChatStore.setState({
        sessions: {
          noProject: {
            id: "noProject",
            label: "No Project",
            messages: [],
            status: "open",
            harness: "claude",
            backendSessionId: null,
            providerResumeId: "conv-no-project",
            projectPath: null,
          },
        },
        activeSessionId: null,
        panelOpen: false,
      });

      const opened = useChatStore.getState().openSession("New Chat", null);

      expect(opened).toBe("noProject");
      expect(useChatStore.getState().sessions[opened]).toMatchObject({
        label: "No Project",
        projectPath: null,
        providerResumeId: "conv-no-project",
      });
    });

    it("hydrates a locally closed session so it can resume", () => {
      const id = useChatStore.getState().openSession("Task One", "/repo/root");
      useChatStore.getState().setProviderResumeId(id, "conv-closed");
      useChatStore.getState().markSessionClosed(id);
      useChatStore.setState({
        sessions: {},
        activeSessionId: null,
        panelOpen: false,
      });

      const reopened = useChatStore
        .getState()
        .openSession("Task One", "/repo/root");

      expect(reopened).toBe(id);
      expect(useChatStore.getState().sessions[reopened]).toMatchObject({
        status: "open",
        lifecycle: "closed",
        providerResumeId: "conv-closed",
      });
    });
  });

  describe("closeSession", () => {
    it("removes the session from the store", () => {
      const id = useChatStore.getState().openSession("T1");
      useChatStore.getState().closeSession(id);

      expect(useChatStore.getState().sessions[id]).toBeUndefined();
    });

    it("keeps durable resume state when closing the in-memory session", () => {
      const id = useChatStore.getState().openSession("T1", "/repo/root");
      useChatStore.getState().setProviderResumeId(id, "conv-close");
      useChatStore.getState().closeSession(id);

      const reopened = useChatStore.getState().openSession("T1", "/repo/root");

      expect(reopened).toBe(id);
      expect(useChatStore.getState().sessions[id].providerResumeId).toBe(
        "conv-close"
      );
    });

    it("selects the last remaining session when active session is closed", () => {
      const id1 = useChatStore.getState().openSession("T1");
      const id2 = useChatStore.getState().startFreshSession("T2");

      // id2 is now active
      expect(useChatStore.getState().activeSessionId).toBe(id2);

      useChatStore.getState().closeSession(id2);
      expect(useChatStore.getState().activeSessionId).toBe(id1);
    });

    it("closes the panel when the last session is closed", () => {
      const id = useChatStore.getState().openSession("T1");
      expect(useChatStore.getState().panelOpen).toBe(true);

      useChatStore.getState().closeSession(id);
      expect(useChatStore.getState().panelOpen).toBe(false);
      expect(useChatStore.getState().activeSessionId).toBeNull();
    });

    it("does nothing for non-existent session", () => {
      const id = useChatStore.getState().openSession("T1");
      useChatStore.getState().closeSession("non-existent");

      expect(useChatStore.getState().sessions[id]).toBeDefined();
      expect(useChatStore.getState().activeSessionId).toBe(id);
    });

    it("does not change active session if non-active is closed", () => {
      const id1 = useChatStore.getState().openSession("T1");
      useChatStore.getState().startFreshSession("T2");
      const id3 = useChatStore.getState().startFreshSession("T3");

      // Make id1 active (not the last in the session list)
      useChatStore.getState().focusSession(id1);
      expect(useChatStore.getState().activeSessionId).toBe(id1);

      // Close id3 (non-active); active should remain id1, not jump to last session
      useChatStore.getState().closeSession(id3);
      expect(useChatStore.getState().activeSessionId).toBe(id1);
    });

    it("preserves panelOpen when other sessions remain", () => {
      useChatStore.getState().openSession("T1");
      const id2 = useChatStore.getState().startFreshSession("T2");
      expect(useChatStore.getState().panelOpen).toBe(true);

      useChatStore.getState().closeSession(id2);
      expect(useChatStore.getState().panelOpen).toBe(true);
    });
  });

  describe("focusSession", () => {
    it("sets the active session", () => {
      const id1 = useChatStore.getState().openSession("T1");
      useChatStore.getState().startFreshSession("T2");

      useChatStore.getState().focusSession(id1);
      expect(useChatStore.getState().activeSessionId).toBe(id1);
    });
  });

  describe("pane layout", () => {
    it("keeps single-pane behavior as the default", () => {
      const first = useChatStore.getState().openSession("First");
      const second = useChatStore.getState().startFreshSession("Second");

      expect(useChatStore.getState().activeSessionId).toBe(second);
      expect(useChatStore.getState().paneLayout.panes).toMatchObject([
        { sessionId: second },
      ]);

      useChatStore.getState().focusSession(first);

      const state = useChatStore.getState();
      expect(state.activeSessionId).toBe(first);
      expect(state.paneLayout.panes).toHaveLength(1);
      expect(state.paneLayout.panes[0].sessionId).toBe(first);
      expect(state.paneLayout.activePaneId).toBe(state.paneLayout.panes[0].id);
    });

    it("adds a fresh chat as a distinct split pane", () => {
      const first = useChatStore.getState().openSession("First");
      const second = useChatStore
        .getState()
        .startFreshSessionInNewPane("Second");

      const state = useChatStore.getState();
      expect(state.activeSessionId).toBe(second);
      expect(state.paneLayout.panes.map((pane) => pane.sessionId)).toEqual([
        first,
        second,
      ]);
      expect(
        new Set(state.paneLayout.panes.map((pane) => pane.sessionId)).size
      ).toBe(2);
    });

    it("supports more than two distinct split panes", () => {
      const first = useChatStore.getState().openSession("First");
      const second = useChatStore
        .getState()
        .startFreshSessionInNewPane("Second");
      const third = useChatStore.getState().startFreshSessionInNewPane("Third");

      const state = useChatStore.getState();
      expect(state.activeSessionId).toBe(third);
      expect(state.paneLayout.panes.map((pane) => pane.sessionId)).toEqual([
        first,
        second,
        third,
      ]);
      expect(
        new Set(state.paneLayout.panes.map((pane) => pane.sessionId)).size
      ).toBe(3);
    });

    it("focuses an existing pane instead of binding one session twice", () => {
      const first = useChatStore.getState().openSession("First");
      const second = useChatStore
        .getState()
        .startFreshSessionInNewPane("Second");
      const [firstPane, secondPane] = useChatStore.getState().paneLayout.panes;

      expect(
        useChatStore.getState().bindPaneToSession(firstPane.id, second)
      ).toBe(true);

      const state = useChatStore.getState();
      expect(state.paneLayout.panes.map((pane) => pane.sessionId)).toEqual([
        first,
        second,
      ]);
      expect(state.paneLayout.activePaneId).toBe(secondPane.id);
      expect(state.activeSessionId).toBe(second);
    });

    it("closes a pane without deleting its session", () => {
      const first = useChatStore.getState().openSession("First");
      const second = useChatStore
        .getState()
        .startFreshSessionInNewPane("Second");
      const secondPane = useChatStore.getState().paneLayout.panes[1];

      useChatStore.getState().closePane(secondPane.id);

      const state = useChatStore.getState();
      expect(state.sessions[second]).toBeDefined();
      expect(state.paneLayout.panes).toEqual([
        expect.objectContaining({ sessionId: first }),
      ]);
      expect(state.activeSessionId).toBe(first);
    });
  });

  describe("local session management", () => {
    it("lists persisted local sessions for the requested project path", () => {
      const idA = useChatStore.getState().openSession("Repo A", "/repo-a");
      useChatStore.getState().addMessage(idA, {
        kind: "user",
        text: "from repo a",
        timestamp: "2026-01-01T00:00:00Z",
      });
      const idB = useChatStore.getState().openSession("Repo B", "/repo-b");
      useChatStore.getState().addMessage(idB, {
        kind: "assistant",
        text: "from repo b",
        timestamp: "2026-01-02T00:00:00Z",
      });

      expect(
        useChatStore
          .getState()
          .listLocalSessions("/repo-b")
          .map((session) => session.id)
      ).toEqual([idB]);
      expect(
        useChatStore.getState().listLocalSessions("/repo-b")[0]
      ).toMatchObject({
        label: "Repo B",
        projectPath: "/repo-b",
      });
    });

    it("selects a persisted session into the active store without duplicating it", async () => {
      persistLocalChatSession({
        id: "persisted",
        label: "Persisted Task",
        messages: [
          {
            kind: "user",
            text: "restore me",
            timestamp: "2026-01-01T00:00:00Z",
          },
        ],
        status: "open",
        harness: "claude",
        backendSessionId: "stale-backend",
        providerResumeId: "conv-resume",
        projectPath: "/repo",
      });

      await expect(
        useChatStore.getState().selectPersistedSession("persisted")
      ).resolves.toBe(true);
      expect(useChatStore.getState().activeSessionId).toBe("persisted");
      expect(Object.keys(useChatStore.getState().sessions)).toEqual([
        "persisted",
      ]);
      expect(useChatStore.getState().sessions.persisted).toMatchObject({
        backendSessionId: null,
        providerResumeId: "conv-resume",
        lifecycleError: null,
        streamingAssistant: null,
      });

      await expect(
        useChatStore.getState().selectPersistedSession("persisted")
      ).resolves.toBe(true);
      expect(Object.keys(useChatStore.getState().sessions)).toEqual([
        "persisted",
      ]);
    });

    it("normalizes legacy Claude-only permission modes in persisted Codex sessions", async () => {
      persistLocalChatSession({
        id: "legacy-codex-permission",
        label: "Legacy Codex permission",
        messages: [],
        status: "open",
        harness: "codex",
        backendSessionId: null,
        providerResumeId: null,
        permissionMode: "plan",
        projectPath: "/repo",
      });

      await expect(
        useChatStore
          .getState()
          .selectPersistedSession("legacy-codex-permission")
      ).resolves.toBe(true);

      expect(
        useChatStore.getState().sessions["legacy-codex-permission"]
          .permissionMode
      ).toBe("default");
      expect(
        loadPersistedLocalChatSession("legacy-codex-permission")?.permissionMode
      ).toBe("default");
    });

    it("focuses an already-loaded session without dropping live runtime state", async () => {
      const id = useChatStore.getState().openSession("Live Task", "/repo");
      useChatStore.getState().setBackendSessionId(id, "live-backend");
      useChatStore.getState().setSessionLifecycle(id, "streaming");

      await expect(
        useChatStore.getState().selectPersistedSession(id)
      ).resolves.toBe(true);

      expect(useChatStore.getState().sessions[id]).toMatchObject({
        backendSessionId: "live-backend",
        lifecycle: "streaming",
      });
    });

    it("deletes one local session without removing unrelated persisted sessions", () => {
      const keep = useChatStore.getState().openSession("Keep", "/repo");
      const remove = useChatStore
        .getState()
        .startFreshSession("Remove", "/repo");
      useChatStore.getState().setProviderResumeId(remove, "conv-remove");

      useChatStore.getState().deleteLocalSession(remove);

      expect(loadPersistedLocalChatSession(remove)).toBeNull();
      expect(loadPersistedLocalChatSession(keep)?.id).toBe(keep);
      expect(useChatStore.getState().sessions[remove]).toBeUndefined();
      expect(useChatStore.getState().sessions[keep]).toBeDefined();
      expect(isLocalChatSessionCleared(remove)).toBe(true);
    });

    it("activates the newest remaining local session when deleting the active one", () => {
      const older = useChatStore.getState().openSession("Older", "/repo");
      useChatStore.getState().addMessage(older, {
        kind: "user",
        text: "old",
        timestamp: "2026-01-01T00:00:00Z",
      });
      const newer = useChatStore.getState().startFreshSession("Newer", "/repo");
      useChatStore.getState().addMessage(newer, {
        kind: "user",
        text: "new",
        timestamp: "2026-01-02T00:00:00Z",
      });
      const active = useChatStore
        .getState()
        .startFreshSession("Active", "/repo");

      useChatStore.getState().deleteLocalSession(active);

      expect(useChatStore.getState().activeSessionId).toBe(newer);
    });

    it("starts a fresh local chat even when a matching project session already exists", () => {
      const existing = useChatStore.getState().openSession("Existing", "/repo");

      const fresh = useChatStore
        .getState()
        .startFreshSession("Task Chat", "/repo");

      expect(fresh).not.toBe(existing);
      expect(useChatStore.getState().activeSessionId).toBe(fresh);
      expect(Object.keys(useChatStore.getState().sessions)).toHaveLength(2);
      expect(loadPersistedLocalChatSession(fresh)).toMatchObject({
        id: fresh,
        label: "Task Chat",
        providerResumeId: null,
      });
    });
  });

  describe("addMessage", () => {
    it("appends a message to the session", () => {
      const id = useChatStore.getState().openSession("T1");

      useChatStore.getState().addMessage(id, {
        kind: "user",
        text: "Hello",
        timestamp: "2024-01-01T00:00:00Z",
      });

      const session = useChatStore.getState().sessions[id];
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0]).toEqual({
        kind: "user",
        text: "Hello",
        timestamp: "2024-01-01T00:00:00Z",
      });
      expect(session.updatedAt).toBe("2024-01-01T00:00:00Z");
    });

    it("coalesces parent-linked assistant deltas into one child transcript row", () => {
      const id = useChatStore.getState().openSession("T1");

      useChatStore.getState().addMessage(id, {
        kind: "assistant",
        text: "child ",
        timestamp: "2024-01-01T00:00:00Z",
        isPartial: true,
        parentToolUseId: "agent-1",
      });
      useChatStore.getState().addMessage(id, {
        kind: "assistant",
        text: "stream",
        timestamp: "2024-01-01T00:00:01Z",
        isPartial: true,
        parentToolUseId: "agent-1",
      });

      const session = useChatStore.getState().sessions[id];
      expect(session.messages).toEqual([
        {
          kind: "assistant",
          text: "child stream",
          timestamp: "2024-01-01T00:00:01Z",
          isPartial: true,
          parentToolUseId: "agent-1",
        },
      ]);
      expect(session.updatedAt).toBe("2024-01-01T00:00:01Z");
    });

    it("replaces parent-linked cumulative assistant snapshots while streaming", () => {
      const id = useChatStore.getState().openSession("T1");

      useChatStore.getState().addMessage(id, {
        kind: "assistant",
        text: "child",
        timestamp: "2024-01-01T00:00:00Z",
        isPartial: true,
        parentToolUseId: "agent-1",
      });
      useChatStore.getState().addMessage(id, {
        kind: "assistant",
        text: "child stream",
        timestamp: "2024-01-01T00:00:01Z",
        isPartial: true,
        parentToolUseId: "agent-1",
      });

      const session = useChatStore.getState().sessions[id];
      expect(session.messages).toEqual([
        {
          kind: "assistant",
          text: "child stream",
          timestamp: "2024-01-01T00:00:01Z",
          isPartial: true,
          parentToolUseId: "agent-1",
        },
      ]);
    });

    it("keeps separate child transcript rows across child tool activity", () => {
      const id = useChatStore.getState().openSession("T1");

      useChatStore.getState().addMessage(id, {
        kind: "assistant",
        text: "before",
        timestamp: "2024-01-01T00:00:00Z",
        isPartial: true,
        parentToolUseId: "agent-1",
      });
      useChatStore.getState().addMessage(id, {
        kind: "tool_call",
        toolName: "Read",
        toolId: "tool-1",
        input: "{}",
        timestamp: "2024-01-01T00:00:01Z",
        parentToolUseId: "agent-1",
      });
      useChatStore.getState().addMessage(id, {
        kind: "assistant",
        text: "after",
        timestamp: "2024-01-01T00:00:02Z",
        isPartial: true,
        parentToolUseId: "agent-1",
      });

      const session = useChatStore.getState().sessions[id];
      expect(session.messages.map((message) => message.kind)).toEqual([
        "assistant",
        "tool_call",
        "assistant",
      ]);
      expect(session.messages[2]).toMatchObject({
        kind: "assistant",
        text: "after",
        parentToolUseId: "agent-1",
      });
    });

    it("replaces accumulated parent-linked assistant deltas with their final materialized message", () => {
      const id = useChatStore.getState().openSession("T1");

      useChatStore.getState().addMessage(id, {
        kind: "assistant",
        text: "before ",
        timestamp: "2024-01-01T00:00:00Z",
        isPartial: true,
        parentToolUseId: "agent-1",
      });
      useChatStore.getState().addMessage(id, {
        kind: "tool_call",
        toolName: "Read",
        toolId: "tool-1",
        input: "{}",
        timestamp: "2024-01-01T00:00:01Z",
        parentToolUseId: "agent-1",
      });
      useChatStore.getState().addMessage(id, {
        kind: "assistant",
        text: "after",
        timestamp: "2024-01-01T00:00:02Z",
        isPartial: true,
        parentToolUseId: "agent-1",
      });
      useChatStore.getState().addMessage(id, {
        kind: "assistant",
        text: "before after",
        timestamp: "2024-01-01T00:00:03Z",
        isPartial: false,
        parentToolUseId: "agent-1",
      });

      const session = useChatStore.getState().sessions[id];
      expect(session.messages).toEqual([
        {
          kind: "tool_call",
          toolName: "Read",
          toolId: "tool-1",
          input: "{}",
          timestamp: "2024-01-01T00:00:01Z",
          parentToolUseId: "agent-1",
        },
        {
          kind: "assistant",
          text: "before after",
          timestamp: "2024-01-01T00:00:03Z",
          isPartial: false,
          parentToolUseId: "agent-1",
        },
      ]);
    });

    it("ignores a duplicate parent-linked final assistant message", () => {
      const id = useChatStore.getState().openSession("T1");

      useChatStore.getState().addMessage(id, {
        kind: "assistant",
        text: "child answer",
        timestamp: "2024-01-01T00:00:00Z",
        isPartial: false,
        parentToolUseId: "agent-1",
      });
      useChatStore.getState().addMessage(id, {
        kind: "assistant",
        text: "child answer",
        timestamp: "2024-01-01T00:00:01Z",
        isPartial: false,
        parentToolUseId: "agent-1",
      });

      const session = useChatStore.getState().sessions[id];
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0]).toMatchObject({
        kind: "assistant",
        text: "child answer",
        parentToolUseId: "agent-1",
      });
    });

    it("updates an existing tool_call with the same toolId in place", () => {
      const id = useChatStore.getState().openSession("T1");

      useChatStore.getState().addMessage(id, {
        kind: "tool_call",
        toolName: "Agent",
        toolId: "agent-1",
        input: '{"description":"Spawn agent","agent_nickname":"Pasteur"}',
        timestamp: "2024-01-01T00:00:00Z",
      });
      useChatStore.getState().addMessage(id, {
        kind: "tool_call",
        toolName: "Agent",
        toolId: "agent-1",
        input: '{"receiver_agents":[{"agent_nickname":"Pasteur"}]}',
        timestamp: "2024-01-01T00:00:01Z",
      });

      const session = useChatStore.getState().sessions[id];
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0]).toEqual({
        kind: "tool_call",
        toolName: "Agent",
        toolId: "agent-1",
        input:
          '{"description":"Spawn agent","agent_nickname":"Pasteur","receiver_agents":[{"agent_nickname":"Pasteur"}]}',
        timestamp: "2024-01-01T00:00:00Z",
      });
      expect(session.updatedAt).toBe("2024-01-01T00:00:01Z");
    });

    it("does nothing for non-existent session", () => {
      useChatStore.getState().addMessage("non-existent", {
        kind: "user",
        text: "Hello",
        timestamp: "2024-01-01T00:00:00Z",
      });

      expect(Object.keys(useChatStore.getState().sessions)).toHaveLength(0);
    });
  });

  describe("updateLastAssistantMessage", () => {
    it("does nothing for non-existent session", () => {
      useChatStore
        .getState()
        .updateLastAssistantMessage("non-existent", "text");
      expect(Object.keys(useChatStore.getState().sessions)).toHaveLength(0);
    });

    it("stores partial text in the ephemeral streaming overlay", () => {
      const id = useChatStore.getState().openSession("T1");

      useChatStore.getState().updateLastAssistantMessage(id, "Start");

      const session = useChatStore.getState().sessions[id];
      expect(session.messages).toEqual([]);
      expect(session.lifecycle).toBe("streaming");
      expect(session.streamingAssistant).toMatchObject({
        text: "Start",
      });
    });

    it("does not persist streaming partial assistant deltas", () => {
      const id = useChatStore.getState().openSession("T1", "/repo/root");

      useChatStore.getState().updateLastAssistantMessage(id, "partial");

      expect(
        useChatStore.getState().sessions[id].streamingAssistant?.text
      ).toBe("partial");
      expect(loadPersistedLocalChatSession(id)?.messages).toEqual([]);
    });

    it("does not leak partial overlay text when metadata persists mid-stream", () => {
      const id = useChatStore.getState().openSession("T1");

      useChatStore.getState().updateLastAssistantMessage(id, "Hel");
      useChatStore.getState().updateLastAssistantMessage(id, "lo");
      useChatStore
        .getState()
        .setSessionUsage(id, "claude-sonnet-4", { used: 10, max: 200000 });

      const session = useChatStore.getState().sessions[id];
      expect(session.streamingAssistant?.text).toBe("Hello");
      expect(session.messages).toEqual([]);
      expect(loadPersistedLocalChatSession(id)?.messages).toEqual([]);
    });

    it("replaces cumulative streaming snapshots instead of appending them as deltas", () => {
      const id = useChatStore.getState().openSession("T1");

      useChatStore.getState().updateLastAssistantMessage(id, "Hel");
      useChatStore.getState().updateLastAssistantMessage(id, "Hello");
      useChatStore.getState().updateLastAssistantMessage(id, "Hello world");

      const session = useChatStore.getState().sessions[id];
      expect(session.streamingAssistant?.text).toBe("Hello world");
      expect(session.messages).toEqual([]);
    });

    it("keeps durable user messages separate from the streaming overlay", () => {
      const id = useChatStore.getState().openSession("T1");

      useChatStore.getState().addMessage(id, {
        kind: "user",
        text: "Question",
        timestamp: "2024-01-01T00:00:00Z",
      });

      useChatStore.getState().updateLastAssistantMessage(id, "Answer");

      const session = useChatStore.getState().sessions[id];
      expect(session.messages).toEqual([
        {
          kind: "user",
          text: "Question",
          timestamp: "2024-01-01T00:00:00Z",
        },
      ]);
      expect(session.streamingAssistant?.text).toBe("Answer");
    });

    it("can commit an interrupted streaming overlay as one durable assistant message", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-02T00:00:00Z"));
      const id = useChatStore.getState().openSession("T1", "/repo/root");

      useChatStore.getState().updateLastAssistantMessage(id, "Partial answer");
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [id]: {
            ...state.sessions[id],
            streamingAssistant: {
              text: "Partial answer",
              timestamp: "2024-01-01T00:00:00Z",
            },
          },
        },
      }));
      useChatStore.getState().clearStreamingAssistant(id, true);

      const session = useChatStore.getState().sessions[id];
      expect(session.streamingAssistant).toBeNull();
      expect(session.messages).toMatchObject([
        {
          kind: "assistant",
          text: "Partial answer",
          isPartial: false,
        },
      ]);
      expect(session.messages[0].timestamp).toBe("2024-01-02T00:00:00.000Z");
      expect(session.updatedAt).toBe("2024-01-02T00:00:00.000Z");
      expect(loadPersistedLocalChatSession(id)?.messages).toEqual([]);
    });

    it("does not recommit streaming text when the final message is already durable", () => {
      const id = useChatStore.getState().openSession("T1", "/repo/root");

      useChatStore.getState().finalizeLastAssistantMessage(id, "Full answer");
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [id]: {
            ...state.sessions[id],
            streamingAssistant: {
              text: "Full answer",
              timestamp: "2024-01-01T00:00:00Z",
            },
          },
        },
      }));

      useChatStore.getState().clearStreamingAssistant(id, true);

      const session = useChatStore.getState().sessions[id];
      expect(session.streamingAssistant).toBeNull();
      expect(session.messages).toMatchObject([
        {
          kind: "assistant",
          text: "Full answer",
          isPartial: false,
        },
      ]);
      expect(session.messages).toHaveLength(1);
      expect(loadPersistedLocalChatSession(id)?.messages).toEqual([]);
    });
  });

  describe("finalizeLastAssistantMessage", () => {
    it("does nothing for non-existent session", () => {
      useChatStore
        .getState()
        .finalizeLastAssistantMessage("non-existent", "text");
      expect(Object.keys(useChatStore.getState().sessions)).toHaveLength(0);
    });

    it("pushes new complete message when last is not partial assistant", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-02T00:00:00Z"));
      const id = useChatStore.getState().openSession("T1");

      useChatStore.getState().addMessage(id, {
        kind: "user",
        text: "Question",
        timestamp: "2024-01-01T00:00:00Z",
      });

      useChatStore.getState().finalizeLastAssistantMessage(id, "Full answer");

      const session = useChatStore.getState().sessions[id];
      expect(session.messages).toHaveLength(2);
      expect(session.messages[1]).toMatchObject({
        kind: "assistant",
        text: "Full answer",
        isPartial: false,
      });
      expect(session.updatedAt).toBe("2024-01-02T00:00:00.000Z");
    });

    it("pushes new complete message when session has no messages", () => {
      const id = useChatStore.getState().openSession("T1");

      useChatStore
        .getState()
        .finalizeLastAssistantMessage(id, "Direct response");

      const session = useChatStore.getState().sessions[id];
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0]).toMatchObject({
        kind: "assistant",
        text: "Direct response",
        isPartial: false,
      });
    });

    it("marks the partial message as complete", () => {
      const id = useChatStore.getState().openSession("T1");

      useChatStore.getState().addMessage(id, {
        kind: "assistant",
        text: "partial...",
        timestamp: "2024-01-01T00:00:00Z",
        isPartial: true,
      });

      useChatStore.getState().finalizeLastAssistantMessage(id, "Full response");

      const session = useChatStore.getState().sessions[id];
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0]).toMatchObject({
        kind: "assistant",
        text: "Full response",
        isPartial: false,
      });
    });

    it("does not persist the finalized assistant transcript", () => {
      const id = useChatStore.getState().openSession("T1", "/repo/root");
      useChatStore.getState().updateLastAssistantMessage(id, "partial");

      useChatStore.getState().finalizeLastAssistantMessage(id, "complete");

      expect(loadPersistedLocalChatSession(id)?.messages).toEqual([]);
    });

    it("does not duplicate a final message after an end event commits streamed text", () => {
      const id = useChatStore.getState().openSession("T1", "/repo/root");

      useChatStore.getState().updateLastAssistantMessage(id, "Full answer");
      useChatStore.getState().clearStreamingAssistant(id, true);
      useChatStore.getState().finalizeLastAssistantMessage(id, "Full answer");

      const session = useChatStore.getState().sessions[id];
      expect(session.streamingAssistant).toBeNull();
      expect(session.messages).toMatchObject([
        {
          kind: "assistant",
          text: "Full answer",
          isPartial: false,
        },
      ]);
      expect(session.messages).toHaveLength(1);
      expect(loadPersistedLocalChatSession(id)?.messages).toEqual([]);
    });

    it("keeps interim result, child-agent events, and later main answer distinct", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-02T00:00:00Z"));
      const id = useChatStore.getState().openSession("T1", "/repo/root");
      useChatStore.getState().setSessionLifecycle(id, "streaming");
      useChatStore.getState().bindActiveTurn(id, "root-turn");

      useChatStore
        .getState()
        .updateLastAssistantMessage(id, "Agent launched and running");
      useChatStore.getState().clearStreamingAssistant(id, true);
      useChatStore
        .getState()
        .finalizeLastAssistantMessage(id, "Agent launched and running");

      useChatStore.getState().addMessage(id, {
        kind: "tool_call",
        toolName: "Task",
        toolId: "toolu_AGENT",
        input: '{"description":"Investigate"}',
        timestamp: "2024-01-02T00:00:01Z",
      });
      useChatStore.getState().addMessage(id, {
        kind: "assistant",
        text: "Child ",
        timestamp: "2024-01-02T00:00:02Z",
        isPartial: true,
        parentToolUseId: "toolu_AGENT",
      });
      useChatStore.getState().addMessage(id, {
        kind: "assistant",
        text: "answer",
        timestamp: "2024-01-02T00:00:03Z",
        isPartial: true,
        parentToolUseId: "toolu_AGENT",
      });
      useChatStore.getState().addMessage(id, {
        kind: "assistant",
        text: "Child answer",
        timestamp: "2024-01-02T00:00:04Z",
        isPartial: false,
        parentToolUseId: "toolu_AGENT",
      });
      useChatStore
        .getState()
        .finalizeLastAssistantMessage(id, "Final main answer");

      const session = useChatStore.getState().sessions[id];
      expect(session.streamingAssistant).toBeNull();
      expect(session.lifecycle).toBe("streaming");
      expect(session.activeTurn).toMatchObject({
        turnId: "root-turn",
        phase: "active",
      });
      expect(session.messages).toEqual([
        {
          kind: "assistant",
          text: "Agent launched and running",
          timestamp: "2024-01-02T00:00:00.000Z",
          isPartial: false,
        },
        {
          kind: "tool_call",
          toolName: "Task",
          toolId: "toolu_AGENT",
          input: '{"description":"Investigate"}',
          timestamp: "2024-01-02T00:00:01Z",
        },
        {
          kind: "assistant",
          text: "Child answer",
          timestamp: "2024-01-02T00:00:04Z",
          isPartial: false,
          parentToolUseId: "toolu_AGENT",
        },
        {
          kind: "assistant",
          text: "Final main answer",
          timestamp: "2024-01-02T00:00:00.000Z",
          isPartial: false,
        },
      ]);
    });

    it("appends a fresh main-thread message instead of clobbering a trailing subagent partial", () => {
      const id = useChatStore.getState().openSession("T1");

      // A subagent's own streamed reply is still an open (partial) message
      // when the main agent's final text arrives.
      useChatStore.getState().addMessage(id, {
        kind: "assistant",
        text: "subagent typing...",
        timestamp: "2024-01-01T00:00:00Z",
        isPartial: true,
        parentToolUseId: "toolu_AGENT",
      });

      useChatStore.getState().finalizeLastAssistantMessage(id, "Main reply");

      const session = useChatStore.getState().sessions[id];
      // The subagent's partial is left untouched...
      expect(session.messages).toHaveLength(2);
      expect(session.messages[0]).toMatchObject({
        kind: "assistant",
        text: "subagent typing...",
        isPartial: true,
        parentToolUseId: "toolu_AGENT",
      });
      // ...and the main agent's reply lands as its OWN main-thread message,
      // not stamped with the subagent's parentToolUseId.
      expect(session.messages[1]).toMatchObject({
        kind: "assistant",
        text: "Main reply",
        isPartial: false,
      });
      expect(session.messages[1]).not.toHaveProperty("parentToolUseId");
    });
  });

  describe("markStreamingIfSending", () => {
    it("upgrades sending sessions to streaming without persisting transcript state", () => {
      const id = useChatStore.getState().openSession("T1", "/repo/root");
      useChatStore.getState().setSessionLifecycle(id, "sending");

      useChatStore.getState().markStreamingIfSending(id);

      expect(useChatStore.getState().sessions[id].lifecycle).toBe("streaming");
      expect(loadPersistedLocalChatSession(id)?.lifecycle).toBe("idle");
    });

    it("does not overwrite idle or error lifecycle resolved by events", () => {
      const id = useChatStore.getState().openSession("T1");

      useChatStore.getState().setSessionLifecycle(id, "idle");
      const idleSession = useChatStore.getState().sessions[id];
      useChatStore.getState().markStreamingIfSending(id);
      expect(useChatStore.getState().sessions[id]).toBe(idleSession);
      expect(useChatStore.getState().sessions[id].lifecycle).toBe("idle");

      useChatStore.getState().setSessionLifecycle(id, "error", "turn failed");
      const errorSession = useChatStore.getState().sessions[id];
      useChatStore.getState().markStreamingIfSending(id);
      expect(useChatStore.getState().sessions[id]).toBe(errorSession);
      expect(useChatStore.getState().sessions[id]).toMatchObject({
        lifecycle: "error",
        lifecycleError: "turn failed",
      });
    });
  });

  describe("active turn state", () => {
    it("tracks a locally accepted turn before binding its root turn ID", () => {
      const id = useChatStore.getState().openSession("T1");

      const localId = useChatStore.getState().beginActiveTurn(id);

      expect(localId).toMatch(/^local-turn-/);
      expect(useChatStore.getState().sessions[id].activeTurn).toEqual({
        localId,
        turnId: null,
        phase: "starting",
      });

      expect(useChatStore.getState().bindActiveTurn(id, "root-turn-1")).toBe(
        true
      );
      expect(useChatStore.getState().sessions[id].activeTurn).toEqual({
        localId,
        turnId: "root-turn-1",
        phase: "active",
      });
    });

    it("settles only a matching provider root turn", () => {
      const id = useChatStore.getState().openSession("T1");
      useChatStore.getState().beginActiveTurn(id);
      useChatStore.getState().bindActiveTurn(id, "root-turn-2");

      expect(
        useChatStore.getState().settleActiveTurn(id, "stale-root-turn")
      ).toBe(false);
      expect(useChatStore.getState().sessions[id].activeTurn?.turnId).toBe(
        "root-turn-2"
      );

      expect(
        useChatStore.getState().settleActiveTurn(id, "root-turn-2")
      ).toBe(true);
      expect(useChatStore.getState().sessions[id].activeTurn).toBeNull();
    });

    it("replaces turn identity when the harness starts a newer root turn", () => {
      const id = useChatStore.getState().openSession("T1");
      useChatStore.getState().bindActiveTurn(id, "root-turn-1");
      const firstLocalId =
        useChatStore.getState().sessions[id].activeTurn?.localId;

      useChatStore.getState().bindActiveTurn(id, "root-turn-2");

      expect(useChatStore.getState().sessions[id].activeTurn).toMatchObject({
        turnId: "root-turn-2",
        phase: "active",
      });
      expect(
        useChatStore.getState().sessions[id].activeTurn?.localId
      ).not.toBe(firstLocalId);
    });

    it("does not persist runtime turn state", () => {
      const id = useChatStore.getState().openSession("T1", "/repo/root");
      useChatStore.getState().beginActiveTurn(id);
      useChatStore.getState().bindActiveTurn(id, "root-turn-1");

      expect(useChatStore.getState().sessions[id].activeTurn).not.toBeNull();
      expect(loadPersistedLocalChatSession(id)?.activeTurn).toBeUndefined();
    });
  });

  describe("setBackendSessionId", () => {
    it("sets the backend session ID", () => {
      const id = useChatStore.getState().openSession("T1");

      useChatStore.getState().setBackendSessionId(id, "claude-session-abc");

      const session = useChatStore.getState().sessions[id];
      expect(session.backendSessionId).toBe("claude-session-abc");
    });

    it("does nothing for non-existent session", () => {
      useChatStore.getState().setBackendSessionId("non-existent", "abc");
      expect(Object.keys(useChatStore.getState().sessions)).toHaveLength(0);
    });
  });

  describe("setProviderResumeId", () => {
    it("sets the conversation ID", () => {
      const id = useChatStore.getState().openSession("T1");

      useChatStore.getState().setProviderResumeId(id, "conv-abc-123");

      const session = useChatStore.getState().sessions[id];
      expect(session.providerResumeId).toBe("conv-abc-123");
    });

    it("does nothing for non-existent session", () => {
      useChatStore.getState().setProviderResumeId("non-existent", "conv-1");
      expect(Object.keys(useChatStore.getState().sessions)).toHaveLength(0);
    });
  });

  describe("setSessionModel", () => {
    it("stores the model name on the session", () => {
      const id = useChatStore.getState().openSession("T1");
      useChatStore.getState().setSessionModel(id, "claude-opus-4-7");
      expect(useChatStore.getState().sessions[id].model).toBe(
        "claude-opus-4-7"
      );
    });

    it("does nothing for non-existent session", () => {
      useChatStore.getState().setSessionModel("non-existent", "m");
      expect(Object.keys(useChatStore.getState().sessions)).toHaveLength(0);
    });

    it("does not update or persist when the model is unchanged", () => {
      const setItem = vi.spyOn(Storage.prototype, "setItem");
      const id = useChatStore.getState().openSession("T1");
      useChatStore.getState().setSessionModel(id, "claude-opus-4-7");
      setItem.mockClear();

      const sessionBefore = useChatStore.getState().sessions[id];
      useChatStore.getState().setSessionModel(id, "claude-opus-4-7");

      expect(useChatStore.getState().sessions[id]).toBe(sessionBefore);
      expect(setItem).not.toHaveBeenCalled();
    });
  });

  describe("setSessionReasoningEffort", () => {
    it("stores the selected reasoning effort on the session", () => {
      const id = useChatStore.getState().openSession("T1");
      useChatStore.getState().setSessionReasoningEffort(id, "high");
      expect(useChatStore.getState().sessions[id].selectedReasoningEffort).toBe(
        "high"
      );
      expect(loadPersistedLocalChatSession(id)?.selectedReasoningEffort).toBe(
        "high"
      );
    });

    it("normalizes an empty reasoning effort to provider default", () => {
      const id = useChatStore.getState().openSession("T1");
      useChatStore.getState().setSessionReasoningEffort(id, "high");
      useChatStore.getState().setSessionReasoningEffort(id, "");
      expect(useChatStore.getState().sessions[id].selectedReasoningEffort).toBe(
        null
      );
      expect(
        loadPersistedLocalChatSession(id)?.selectedReasoningEffort
      ).toBeNull();
    });
  });

  describe("setSessionTokenUsage", () => {
    it("stores used + max on the session", () => {
      const id = useChatStore.getState().openSession("T1");
      useChatStore
        .getState()
        .setSessionTokenUsage(id, { used: 142_000, max: 1_000_000 });
      expect(useChatStore.getState().sessions[id].tokenUsage).toEqual({
        used: 142_000,
        max: 1_000_000,
      });
    });

    it("overwrites previous usage on later turns", () => {
      const id = useChatStore.getState().openSession("T1");
      useChatStore
        .getState()
        .setSessionTokenUsage(id, { used: 100, max: 1_000_000 });
      useChatStore
        .getState()
        .setSessionTokenUsage(id, { used: 200, max: 1_000_000 });
      expect(useChatStore.getState().sessions[id].tokenUsage?.used).toBe(200);
    });

    it("does not update or persist when token usage is unchanged", () => {
      const setItem = vi.spyOn(Storage.prototype, "setItem");
      const id = useChatStore.getState().openSession("T1");
      useChatStore
        .getState()
        .setSessionTokenUsage(id, { used: 100, max: 1_000_000 });
      setItem.mockClear();

      const sessionBefore = useChatStore.getState().sessions[id];
      useChatStore
        .getState()
        .setSessionTokenUsage(id, { used: 100, max: 1_000_000 });

      expect(useChatStore.getState().sessions[id]).toBe(sessionBefore);
      expect(setItem).not.toHaveBeenCalled();
    });
  });

  describe("setSessionUsage", () => {
    it("sets model and tokenUsage together in one update", () => {
      const id = useChatStore.getState().openSession("T1");
      useChatStore.getState().setSessionUsage(id, "claude-opus-4-7", {
        used: 142_000,
        max: 1_000_000,
      });
      const session = useChatStore.getState().sessions[id];
      expect(session.model).toBe("claude-opus-4-7");
      expect(session.tokenUsage).toEqual({ used: 142_000, max: 1_000_000 });
    });

    it("does nothing for non-existent session", () => {
      useChatStore
        .getState()
        .setSessionUsage("non-existent", "m", { used: 0, max: 0 });
      expect(Object.keys(useChatStore.getState().sessions)).toHaveLength(0);
    });

    it("does not update or persist when model and usage are unchanged", () => {
      const setItem = vi.spyOn(Storage.prototype, "setItem");
      const id = useChatStore.getState().openSession("T1");
      useChatStore.getState().setSessionUsage(id, "claude-opus-4-7", {
        used: 142_000,
        max: 1_000_000,
      });
      setItem.mockClear();

      const sessionBefore = useChatStore.getState().sessions[id];
      useChatStore.getState().setSessionUsage(id, "claude-opus-4-7", {
        used: 142_000,
        max: 1_000_000,
      });

      expect(useChatStore.getState().sessions[id]).toBe(sessionBefore);
      expect(setItem).not.toHaveBeenCalled();
    });
  });

  describe("markSessionClosed", () => {
    it("sets local lifecycle to closed without deleting a durable session", () => {
      const id = useChatStore.getState().openSession("T1");
      useChatStore.getState().addMessage(id, {
        kind: "user",
        text: "Hello",
        timestamp: "2024-01-01T00:00:00Z",
      });
      useChatStore.getState().setBackendSessionId(id, "backend-1");

      useChatStore.getState().markSessionClosed(id);

      const session = useChatStore.getState().sessions[id];
      expect(session.status).toBe("open");
      expect(session.lifecycle).toBe("closed");
      expect(session.backendSessionId).toBeNull();
    });

    it("drops empty closed sessions from runtime and local history", () => {
      const id = useChatStore.getState().openSession("T1", "/repo");
      useChatStore.getState().setBackendSessionId(id, "backend-1");

      useChatStore.getState().markSessionClosed(id);

      expect(useChatStore.getState().sessions[id]).toBeUndefined();
      expect(useChatStore.getState().activeSessionId).toBeNull();
      expect(useChatStore.getState().panelOpen).toBe(false);
      expect(loadPersistedLocalChatSession(id)).toBeNull();
      expect(useChatStore.getState().listLocalSessions("/repo")).toEqual([]);
    });

    it("preserves durable resume state when a backend session closes", () => {
      const id = useChatStore.getState().openSession("T1");
      useChatStore.getState().addMessage(id, {
        kind: "user",
        text: "Hello",
        timestamp: "2024-01-01T00:00:00Z",
      });
      useChatStore.getState().setProviderResumeId(id, "conv-keep");
      expect(loadPersistedLocalChatSession(id)).not.toBeNull();

      useChatStore.getState().markSessionClosed(id);

      expect(loadPersistedLocalChatSession(id)).toMatchObject({
        id,
        lifecycle: "closed",
        backendSessionId: null,
        providerResumeId: "conv-keep",
        messages: [],
      });
    });

    it("does nothing for non-existent session", () => {
      const id = useChatStore.getState().openSession("T1");
      useChatStore.getState().markSessionClosed("non-existent");

      expect(useChatStore.getState().sessions[id].status).toBe("open");
      expect(Object.keys(useChatStore.getState().sessions)).toHaveLength(1);
    });
  });

  describe("setSessionTitleCandidate", () => {
    it("keeps low-confidence candidates hidden while tracking the attempt", () => {
      const id = useChatStore.getState().openSession("New Chat");

      useChatStore.getState().setSessionTitleCandidate(id, {
        title: null,
        confidence: 0.12,
        sufficientSignal: false,
        userMessageCount: 1,
      });

      expect(useChatStore.getState().sessions[id]).toMatchObject({
        title: null,
        titleStatus: "low_confidence",
        titleConfidence: 0.12,
        titleUserMessageCount: 1,
      });
      expect(loadPersistedLocalChatSession(id)).toMatchObject({
        title: null,
        titleStatus: "low_confidence",
        titleConfidence: 0.12,
        titleUserMessageCount: 1,
      });
    });

    it("freezes confident generated titles", () => {
      const id = useChatStore.getState().openSession("New Chat");

      useChatStore.getState().setSessionTitleCandidate(id, {
        title: "Fix Local Chat Titles",
        confidence: 0.86,
        sufficientSignal: true,
        userMessageCount: 2,
      });

      expect(useChatStore.getState().sessions[id]).toMatchObject({
        title: "Fix Local Chat Titles",
        titleStatus: "generated",
        titleConfidence: 0.86,
        titleUserMessageCount: 2,
      });
    });

    it("freezes the mini-panel summary after a generated title is set", () => {
      const id = useChatStore.getState().openSession("New Chat");
      useChatStore.getState().setSessionTitleCandidate(id, {
        title: "Fix Local Chat Titles",
        confidence: 0.86,
        sufficientSignal: true,
        userMessageCount: 2,
      });
      const frozenSummary = useChatStore.getState().localSessionSummaries[id];

      useChatStore.getState().addMessage(id, {
        kind: "user",
        text: "follow-up",
        timestamp: "2026-01-02T00:00:00Z",
      });

      expect(useChatStore.getState().localSessionSummaries[id]).toBe(
        frozenSummary
      );
      expect(useChatStore.getState().localSessionSummaries[id]).toMatchObject({
        title: "Fix Local Chat Titles",
        updatedAt: frozenSummary.updatedAt,
        messageCount: frozenSummary.messageCount,
      });
      expect(loadPersistedLocalChatSession(id)).toMatchObject({
        updatedAt: "2026-01-02T00:00:00Z",
        messageCount: 1,
      });
    });

    it("does not overwrite a frozen generated title", () => {
      const id = useChatStore.getState().openSession("New Chat");
      useChatStore.getState().setSessionTitleCandidate(id, {
        title: "Fix Local Chat Titles",
        confidence: 0.86,
        sufficientSignal: true,
        userMessageCount: 2,
      });

      useChatStore.getState().setSessionTitleCandidate(id, {
        title: "Different Title",
        confidence: 0.92,
        sufficientSignal: true,
        userMessageCount: 3,
      });

      expect(useChatStore.getState().sessions[id].title).toBe(
        "Fix Local Chat Titles"
      );
      expect(useChatStore.getState().sessions[id].titleUserMessageCount).toBe(
        2
      );
    });
  });

  describe("clearMessages", () => {
    it("empties the messages array", () => {
      const id = useChatStore.getState().openSession("T1");

      useChatStore.getState().addMessage(id, {
        kind: "user",
        text: "Hello",
        timestamp: "2024-01-01T00:00:00Z",
      });

      expect(useChatStore.getState().sessions[id].messages).toHaveLength(1);

      useChatStore.getState().clearMessages(id);
      expect(useChatStore.getState().sessions[id].messages).toHaveLength(0);
    });

    it("deletes durable resume state so cleared chats are not restored", () => {
      const id = useChatStore.getState().openSession("T1", "/repo/root");
      useChatStore.getState().addMessage(id, {
        kind: "user",
        text: "remove me",
        timestamp: "2026-01-01T00:00:00Z",
      });
      useChatStore.getState().setBackendSessionId(id, "backend-clear");
      useChatStore.getState().setProviderResumeId(id, "conv-clear");
      expect(loadPersistedLocalChatSession(id)?.providerResumeId).toBe(
        "conv-clear"
      );

      useChatStore.getState().clearMessages(id);

      expect(loadPersistedLocalChatSession(id)).toBeNull();
      expect(useChatStore.getState().sessions[id]).toMatchObject({
        messages: [],
        backendSessionId: null,
        providerResumeId: null,
        status: "open",
      });

      useChatStore.setState({
        sessions: {},
        activeSessionId: null,
        panelOpen: false,
      });
      const reopened = useChatStore.getState().openSession("T1", "/repo/root");

      expect(reopened).not.toBe(id);
      expect(useChatStore.getState().sessions[reopened].messages).toEqual([]);
      expect(
        useChatStore.getState().sessions[reopened].providerResumeId
      ).toBeNull();
    });

    it("does nothing for non-existent session", () => {
      const id = useChatStore.getState().openSession("T1");
      useChatStore.getState().addMessage(id, {
        kind: "user",
        text: "Hello",
        timestamp: "2024-01-01T00:00:00Z",
      });

      useChatStore.getState().clearMessages("non-existent");
      expect(useChatStore.getState().sessions[id].messages).toHaveLength(1);
      expect(Object.keys(useChatStore.getState().sessions)).toHaveLength(1);
    });
  });

  describe("structured user questions", () => {
    it("replaces a matching generic AskUserQuestion row and tracks resolution", () => {
      const id = useChatStore.getState().openSession("Question");
      useChatStore.getState().addMessage(id, {
        kind: "tool_call",
        toolName: "AskUserQuestion",
        toolId: "tool-1",
        input: "{}",
        timestamp: "2026-07-14T00:00:00Z",
      });
      useChatStore.getState().addMessage(id, {
        kind: "user_question",
        requestId: "req-1",
        toolUseId: "tool-1",
        questions: [],
        originalQuestions: [],
        inputError: "invalid",
        status: "pending",
        timestamp: "2026-07-14T00:00:01Z",
      });

      expect(useChatStore.getState().sessions[id].messages).toEqual([
        expect.objectContaining({ kind: "user_question", requestId: "req-1" }),
      ]);

      useChatStore.getState().addMessage(id, {
        kind: "tool_result",
        toolId: "tool-1",
        result: "answer received",
        isError: false,
        timestamp: "2026-07-14T00:00:02Z",
      });
      expect(useChatStore.getState().sessions[id].messages).toHaveLength(1);

      useChatStore.getState().resolveUserQuestion(id, "req-1");
      expect(useChatStore.getState().sessions[id].messages[0]).toMatchObject({
        kind: "user_question",
        status: "resolved",
      });
    });

    it("marks pending cards unavailable when the backend exits", () => {
      const id = useChatStore.getState().openSession("Question");
      useChatStore.getState().addMessage(id, {
        kind: "user_question",
        requestId: "req-1",
        toolUseId: "tool-1",
        questions: [],
        originalQuestions: [],
        status: "pending",
        timestamp: "2026-07-14T00:00:00Z",
      });
      useChatStore.getState().markPendingUserQuestionsUnavailable(id);
      expect(useChatStore.getState().sessions[id].messages[0]).toMatchObject({
        status: "unavailable",
      });
    });
  });

  describe("togglePanel / setPanelOpen", () => {
    it("toggles the panel open state", () => {
      expect(useChatStore.getState().panelOpen).toBe(false);

      useChatStore.getState().togglePanel();
      expect(useChatStore.getState().panelOpen).toBe(true);

      useChatStore.getState().togglePanel();
      expect(useChatStore.getState().panelOpen).toBe(false);
    });

    it("sets panel open state explicitly", () => {
      useChatStore.getState().setPanelOpen(true);
      expect(useChatStore.getState().panelOpen).toBe(true);

      useChatStore.getState().setPanelOpen(false);
      expect(useChatStore.getState().panelOpen).toBe(false);
    });
  });
});
