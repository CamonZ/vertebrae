import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore, getParentScope } from "./chatStore";

describe("chatStore", () => {
  beforeEach(() => {
    // Reset store to initial state
    useChatStore.setState({
      sessions: {},
      activeSessionId: null,
      panelOpen: false,
    });
  });

  describe("openSession", () => {
    it("creates a new session with the given scope and entity", () => {
      const id = useChatStore.getState().openSession("task", "task-123", "My Task");

      expect(id).toBeTruthy();
      const session = useChatStore.getState().sessions[id];
      expect(session).toBeDefined();
      expect(session.scope).toBe("task");
      expect(session.entityId).toBe("task-123");
      expect(session.label).toBe("My Task");
      expect(session.messages).toEqual([]);
      expect(session.status).toBe("open");
      expect(session.claudeSessionId).toBeNull();
    });

    it("sets the new session as active and opens the panel", () => {
      const id = useChatStore.getState().openSession("workflow", "wf-1", "Workflow 1");

      expect(useChatStore.getState().activeSessionId).toBe(id);
      expect(useChatStore.getState().panelOpen).toBe(true);
    });

    it("reuses existing session for same scope+entity", () => {
      const id1 = useChatStore.getState().openSession("task", "task-123", "Task A");
      const id2 = useChatStore.getState().openSession("task", "task-123", "Task A");

      expect(id1).toBe(id2);
      expect(Object.keys(useChatStore.getState().sessions)).toHaveLength(1);
    });

    it("reusing session sets it as active and opens panel", () => {
      const id1 = useChatStore.getState().openSession("task", "task-1", "T1");
      useChatStore.getState().openSession("task", "task-2", "T2");

      // Close panel manually
      useChatStore.getState().setPanelOpen(false);
      expect(useChatStore.getState().panelOpen).toBe(false);

      // Reopen same session
      useChatStore.getState().openSession("task", "task-1", "T1");
      expect(useChatStore.getState().activeSessionId).toBe(id1);
      expect(useChatStore.getState().panelOpen).toBe(true);
    });

    it("creates separate sessions for different entities", () => {
      const id1 = useChatStore.getState().openSession("task", "task-1", "Task 1");
      const id2 = useChatStore.getState().openSession("task", "task-2", "Task 2");

      expect(id1).not.toBe(id2);
      expect(Object.keys(useChatStore.getState().sessions)).toHaveLength(2);
    });

    it("creates separate sessions for different scopes on same entity", () => {
      const id1 = useChatStore.getState().openSession("task", "entity-1", "Task View");
      const id2 = useChatStore.getState().openSession("workflow", "entity-1", "Workflow View");

      expect(id1).not.toBe(id2);
      expect(Object.keys(useChatStore.getState().sessions)).toHaveLength(2);
    });

    it("supports project scope with null entityId", () => {
      const id = useChatStore.getState().openSession("project", null, "Project Chat");

      const session = useChatStore.getState().sessions[id];
      expect(session.scope).toBe("project");
      expect(session.entityId).toBeNull();
    });

    it("stores the project path captured when the session is opened", () => {
      const id = useChatStore
        .getState()
        .openSession("project", null, "Project Chat", "/repo/root");

      expect(useChatStore.getState().sessions[id].projectPath).toBe("/repo/root");
    });
  });

  describe("closeSession", () => {
    it("removes the session from the store", () => {
      const id = useChatStore.getState().openSession("task", "t-1", "T1");
      useChatStore.getState().closeSession(id);

      expect(useChatStore.getState().sessions[id]).toBeUndefined();
    });

    it("selects the last remaining session when active session is closed", () => {
      const id1 = useChatStore.getState().openSession("task", "t-1", "T1");
      const id2 = useChatStore.getState().openSession("task", "t-2", "T2");

      // id2 is now active
      expect(useChatStore.getState().activeSessionId).toBe(id2);

      useChatStore.getState().closeSession(id2);
      expect(useChatStore.getState().activeSessionId).toBe(id1);
    });

    it("closes the panel when the last session is closed", () => {
      const id = useChatStore.getState().openSession("task", "t-1", "T1");
      expect(useChatStore.getState().panelOpen).toBe(true);

      useChatStore.getState().closeSession(id);
      expect(useChatStore.getState().panelOpen).toBe(false);
      expect(useChatStore.getState().activeSessionId).toBeNull();
    });

    it("does nothing for non-existent session", () => {
      const id = useChatStore.getState().openSession("task", "t-1", "T1");
      useChatStore.getState().closeSession("non-existent");

      expect(useChatStore.getState().sessions[id]).toBeDefined();
      expect(useChatStore.getState().activeSessionId).toBe(id);
    });

    it("does not change active session if non-active is closed", () => {
      const id1 = useChatStore.getState().openSession("task", "t-1", "T1");
      useChatStore.getState().openSession("task", "t-2", "T2");
      const id3 = useChatStore.getState().openSession("task", "t-3", "T3");

      // Make id1 active (not the last in the session list)
      useChatStore.getState().focusSession(id1);
      expect(useChatStore.getState().activeSessionId).toBe(id1);

      // Close id3 (non-active); active should remain id1, not jump to last session
      useChatStore.getState().closeSession(id3);
      expect(useChatStore.getState().activeSessionId).toBe(id1);
    });

    it("preserves panelOpen when other sessions remain", () => {
      useChatStore.getState().openSession("task", "t-1", "T1");
      const id2 = useChatStore.getState().openSession("task", "t-2", "T2");
      expect(useChatStore.getState().panelOpen).toBe(true);

      useChatStore.getState().closeSession(id2);
      expect(useChatStore.getState().panelOpen).toBe(true);
    });
  });

  describe("focusSession", () => {
    it("sets the active session", () => {
      const id1 = useChatStore.getState().openSession("task", "t-1", "T1");
      useChatStore.getState().openSession("task", "t-2", "T2");

      useChatStore.getState().focusSession(id1);
      expect(useChatStore.getState().activeSessionId).toBe(id1);
    });
  });

  describe("addMessage", () => {
    it("appends a message to the session", () => {
      const id = useChatStore.getState().openSession("task", "t-1", "T1");

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
      useChatStore.getState().updateLastAssistantMessage("non-existent", "text");
      expect(Object.keys(useChatStore.getState().sessions)).toHaveLength(0);
    });

    it("creates new partial message when session has no messages", () => {
      const id = useChatStore.getState().openSession("task", "t-1", "T1");

      useChatStore.getState().updateLastAssistantMessage(id, "Start");

      const session = useChatStore.getState().sessions[id];
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0]).toMatchObject({
        kind: "assistant",
        text: "Start",
        isPartial: true,
      });
    });

    it("appends text to existing partial assistant message", () => {
      const id = useChatStore.getState().openSession("task", "t-1", "T1");

      useChatStore.getState().addMessage(id, {
        kind: "assistant",
        text: "Hel",
        timestamp: "2024-01-01T00:00:00Z",
        isPartial: true,
      });

      useChatStore.getState().updateLastAssistantMessage(id, "lo");

      const session = useChatStore.getState().sessions[id];
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0]).toMatchObject({
        kind: "assistant",
        text: "Hello",
        isPartial: true,
      });
    });

    it("creates new partial message when last message is not assistant", () => {
      const id = useChatStore.getState().openSession("task", "t-1", "T1");

      useChatStore.getState().addMessage(id, {
        kind: "user",
        text: "Question",
        timestamp: "2024-01-01T00:00:00Z",
      });

      useChatStore.getState().updateLastAssistantMessage(id, "Answer");

      const session = useChatStore.getState().sessions[id];
      expect(session.messages).toHaveLength(2);
      expect(session.messages[1]).toMatchObject({
        kind: "assistant",
        text: "Answer",
        isPartial: true,
      });
    });
  });

  describe("finalizeLastAssistantMessage", () => {
    it("does nothing for non-existent session", () => {
      useChatStore.getState().finalizeLastAssistantMessage("non-existent", "text");
      expect(Object.keys(useChatStore.getState().sessions)).toHaveLength(0);
    });

    it("pushes new complete message when last is not partial assistant", () => {
      const id = useChatStore.getState().openSession("task", "t-1", "T1");

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
    });

    it("pushes new complete message when session has no messages", () => {
      const id = useChatStore.getState().openSession("task", "t-1", "T1");

      useChatStore.getState().finalizeLastAssistantMessage(id, "Direct response");

      const session = useChatStore.getState().sessions[id];
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0]).toMatchObject({
        kind: "assistant",
        text: "Direct response",
        isPartial: false,
      });
    });

    it("marks the partial message as complete", () => {
      const id = useChatStore.getState().openSession("task", "t-1", "T1");

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
  });

  describe("setClaudeSessionId", () => {
    it("sets the backend session ID", () => {
      const id = useChatStore.getState().openSession("task", "t-1", "T1");

      useChatStore.getState().setClaudeSessionId(id, "claude-session-abc");

      const session = useChatStore.getState().sessions[id];
      expect(session.claudeSessionId).toBe("claude-session-abc");
    });

    it("does nothing for non-existent session", () => {
      useChatStore.getState().setClaudeSessionId("non-existent", "abc");
      expect(Object.keys(useChatStore.getState().sessions)).toHaveLength(0);
    });
  });

  describe("setClaudeConversationId", () => {
    it("sets the conversation ID", () => {
      const id = useChatStore.getState().openSession("task", "t-1", "T1");

      useChatStore.getState().setClaudeConversationId(id, "conv-abc-123");

      const session = useChatStore.getState().sessions[id];
      expect(session.claudeConversationId).toBe("conv-abc-123");
    });

    it("does nothing for non-existent session", () => {
      useChatStore.getState().setClaudeConversationId("non-existent", "conv-1");
      expect(Object.keys(useChatStore.getState().sessions)).toHaveLength(0);
    });
  });

  describe("setContextSummary", () => {
    it("stores the context summary text", () => {
      const id = useChatStore.getState().openSession("task", "t-1", "T1");

      useChatStore.getState().setContextSummary(id, "[Context: Task]\nTask: My Task");

      const session = useChatStore.getState().sessions[id];
      expect(session.contextSummary).toBe("[Context: Task]\nTask: My Task");
    });

    it("does nothing for non-existent session", () => {
      useChatStore.getState().setContextSummary("non-existent", "summary");
      expect(Object.keys(useChatStore.getState().sessions)).toHaveLength(0);
    });
  });

  describe("setSessionModel", () => {
    it("stores the model name on the session", () => {
      const id = useChatStore.getState().openSession("task", "t-1", "T1");
      useChatStore.getState().setSessionModel(id, "claude-opus-4-7");
      expect(useChatStore.getState().sessions[id].model).toBe(
        "claude-opus-4-7"
      );
    });

    it("does nothing for non-existent session", () => {
      useChatStore.getState().setSessionModel("non-existent", "m");
      expect(Object.keys(useChatStore.getState().sessions)).toHaveLength(0);
    });
  });

  describe("setSessionTokenUsage", () => {
    it("stores used + max on the session", () => {
      const id = useChatStore.getState().openSession("task", "t-1", "T1");
      useChatStore
        .getState()
        .setSessionTokenUsage(id, { used: 142_000, max: 1_000_000 });
      expect(useChatStore.getState().sessions[id].tokenUsage).toEqual({
        used: 142_000,
        max: 1_000_000,
      });
    });

    it("overwrites previous usage on later turns", () => {
      const id = useChatStore.getState().openSession("task", "t-1", "T1");
      useChatStore
        .getState()
        .setSessionTokenUsage(id, { used: 100, max: 1_000_000 });
      useChatStore
        .getState()
        .setSessionTokenUsage(id, { used: 200, max: 1_000_000 });
      expect(useChatStore.getState().sessions[id].tokenUsage?.used).toBe(200);
    });
  });

  describe("setSessionUsage", () => {
    it("sets model and tokenUsage together in one update", () => {
      const id = useChatStore.getState().openSession("task", "t-1", "T1");
      useChatStore
        .getState()
        .setSessionUsage(id, "claude-opus-4-7", { used: 142_000, max: 1_000_000 });
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
  });

  describe("markSessionClosed", () => {
    it("sets session status to closed", () => {
      const id = useChatStore.getState().openSession("task", "t-1", "T1");

      useChatStore.getState().markSessionClosed(id);

      const session = useChatStore.getState().sessions[id];
      expect(session.status).toBe("closed");
    });

    it("does nothing for non-existent session", () => {
      const id = useChatStore.getState().openSession("task", "t-1", "T1");
      useChatStore.getState().markSessionClosed("non-existent");

      expect(useChatStore.getState().sessions[id].status).toBe("open");
      expect(Object.keys(useChatStore.getState().sessions)).toHaveLength(1);
    });
  });

  describe("clearMessages", () => {
    it("empties the messages array", () => {
      const id = useChatStore.getState().openSession("task", "t-1", "T1");

      useChatStore.getState().addMessage(id, {
        kind: "user",
        text: "Hello",
        timestamp: "2024-01-01T00:00:00Z",
      });

      expect(useChatStore.getState().sessions[id].messages).toHaveLength(1);

      useChatStore.getState().clearMessages(id);
      expect(useChatStore.getState().sessions[id].messages).toHaveLength(0);
    });

    it("does nothing for non-existent session", () => {
      const id = useChatStore.getState().openSession("task", "t-1", "T1");
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

  describe("widenScope", () => {
    it("updates session scope, entityId, and label", () => {
      const id = useChatStore.getState().openSession("step", "step-1", "Step 1");

      useChatStore.getState().widenScope(id, "task", "task-1", "Task Chat");

      const session = useChatStore.getState().sessions[id];
      expect(session.scope).toBe("task");
      expect(session.entityId).toBe("task-1");
      expect(session.label).toBe("Task Chat");
    });

    it("does nothing for non-existent session", () => {
      const id = useChatStore.getState().openSession("step", "step-1", "Step 1");
      useChatStore.getState().widenScope("non-existent", "task", "task-1", "Task Chat");

      const session = useChatStore.getState().sessions[id];
      expect(session.scope).toBe("step");
      expect(Object.keys(useChatStore.getState().sessions)).toHaveLength(1);
    });
  });

  describe("findSession", () => {
    it("finds an existing open session by scope and entityId", () => {
      const id = useChatStore.getState().openSession("task", "t-1", "T1");

      const found = useChatStore.getState().findSession("task", "t-1");
      expect(found).toBe(id);
    });

    it("returns null when no matching session exists", () => {
      useChatStore.getState().openSession("task", "t-1", "T1");

      const found = useChatStore.getState().findSession("task", "t-999");
      expect(found).toBeNull();
    });

    it("does not find closed sessions", () => {
      const id = useChatStore.getState().openSession("task", "t-1", "T1");
      useChatStore.getState().markSessionClosed(id);

      const found = useChatStore.getState().findSession("task", "t-1");
      expect(found).toBeNull();
    });
  });
});

describe("getParentScope", () => {
  it("returns task for step", () => {
    expect(getParentScope("step")).toBe("task");
  });

  it("returns workflow for task", () => {
    expect(getParentScope("task")).toBe("workflow");
  });

  it("returns project for workflow", () => {
    expect(getParentScope("workflow")).toBe("project");
  });

  it("returns null for project (top level)", () => {
    expect(getParentScope("project")).toBeNull();
  });
});
