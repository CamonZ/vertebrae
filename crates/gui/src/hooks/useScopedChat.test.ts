import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleInitEvent,
  handleUsageEvent,
  handleTextEvent,
  handleToolCallEvent,
  handleToolResultEvent,
  handlePermissionRequestEvent,
  handleEndEvent,
  handleErrorEvent,
  doStartSession,
  doSendMessage,
  doCloseSession,
} from "./useScopedChat";
import type { ChatSession } from "../stores/chatStore";
import { commands } from "../bindings";

vi.mock("../bindings", () => ({
  commands: {
    getCurrentProjectPath: vi.fn().mockResolvedValue({
      status: "ok",
      data: "/test/project",
    }),
    createClaudeSession: vi.fn().mockResolvedValue({ status: "ok" }),
    sendClaudeMessage: vi.fn().mockResolvedValue({ status: "ok" }),
    closeClaudeSession: vi.fn().mockResolvedValue({ status: "ok" }),
    createChatSession: vi.fn(),
    sendChatMessage: vi.fn(),
    listChatSessions: vi.fn(),
    listChatMessages: vi.fn(),
    setActiveChatSessionId: vi.fn(),
    getCurrentProject: vi.fn().mockResolvedValue({
      status: "ok",
      data: "test-project",
    }),
    getTask: vi.fn().mockResolvedValue({ status: "error", error: "unused" }),
    getTaskExecutions: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
    getWorkflowWithTasks: vi
      .fn()
      .mockResolvedValue({ status: "error", error: "unused" }),
    getStep: vi.fn().mockResolvedValue({ status: "error", error: "unused" }),
  },
  events: {},
}));

vi.mock("../utils/chatContext", () => ({
  buildContextSummary: vi.fn().mockResolvedValue(null),
  buildInitialPrompt: vi.fn((ctx: string | null, msg: string) =>
    ctx ? `${ctx}\n\n---\n\n${msg}` : msg
  ),
}));

const mockedCommands = vi.mocked(commands);

const SESSION_ID = "session-1";
const CLAUDE_SESSION_ID = "claude-backend-123";
const OTHER_SESSION_ID = "other-backend-456";

describe("handleInitEvent", () => {
  it("calls setClaudeConversationId and setSessionModel when session matches", () => {
    const setConvId = vi.fn();
    const setModel = vi.fn();
    handleInitEvent(
      {
        session_id: CLAUDE_SESSION_ID,
        claude_conversation_id: "conv-abc",
        model: "claude-sonnet-4",
        tools: [],
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      setConvId,
      setModel
    );
    expect(setConvId).toHaveBeenCalledWith(SESSION_ID, "conv-abc");
    expect(setModel).toHaveBeenCalledWith(SESSION_ID, "claude-sonnet-4");
  });

  it("does nothing when session ID does not match", () => {
    const setConvId = vi.fn();
    const setModel = vi.fn();
    handleInitEvent(
      {
        session_id: OTHER_SESSION_ID,
        claude_conversation_id: "conv-abc",
        model: "claude-sonnet-4",
        tools: [],
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      setConvId,
      setModel
    );
    expect(setConvId).not.toHaveBeenCalled();
    expect(setModel).not.toHaveBeenCalled();
  });

  it("does not call setClaudeConversationId when conversation ID is null", () => {
    const setConvId = vi.fn();
    const setModel = vi.fn();
    handleInitEvent(
      {
        session_id: CLAUDE_SESSION_ID,
        claude_conversation_id: null,
        model: "claude-sonnet-4",
        tools: [],
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      setConvId,
      setModel
    );
    expect(setConvId).not.toHaveBeenCalled();
    expect(setModel).toHaveBeenCalledWith(SESSION_ID, "claude-sonnet-4");
  });
});

describe("handleUsageEvent", () => {
  it("computes max from frontend lookup table for opus 4.7 and calls setSessionUsage", () => {
    const setUsage = vi.fn();
    handleUsageEvent(
      {
        session_id: CLAUDE_SESSION_ID,
        model: "claude-opus-4-7-20250115",
        context_tokens: 142_000,
        // Backend reports 200k fallback — should be overridden by lookup table.
        context_window: 200_000,
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      setUsage
    );
    expect(setUsage).toHaveBeenCalledWith(
      SESSION_ID,
      "claude-opus-4-7-20250115",
      {
        used: 142_000,
        max: 1_000_000,
      }
    );
  });

  it("falls back to backend context_window when model not in lookup table", () => {
    const setUsage = vi.fn();
    handleUsageEvent(
      {
        session_id: CLAUDE_SESSION_ID,
        model: "claude-mystery-9-9",
        context_tokens: 50_000,
        context_window: 250_000,
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      setUsage
    );
    expect(setUsage).toHaveBeenCalledWith(SESSION_ID, "claude-mystery-9-9", {
      used: 50_000,
      max: 250_000,
    });
  });

  it("ignores events for a different session", () => {
    const setUsage = vi.fn();
    handleUsageEvent(
      {
        session_id: OTHER_SESSION_ID,
        model: "claude-opus-4-7",
        context_tokens: 1,
        context_window: 200_000,
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      setUsage
    );
    expect(setUsage).not.toHaveBeenCalled();
  });
});

describe("handleTextEvent", () => {
  it("updates partial text immediately when session matches", () => {
    const updateLastAssistantMessage = vi.fn();
    const finalizeLastAssistantMessage = vi.fn();
    handleTextEvent(
      { session_id: CLAUDE_SESSION_ID, text: "hello", is_partial: true },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      updateLastAssistantMessage,
      finalizeLastAssistantMessage
    );
    expect(updateLastAssistantMessage).toHaveBeenCalledWith(
      SESSION_ID,
      "hello"
    );
    expect(finalizeLastAssistantMessage).not.toHaveBeenCalled();
  });

  it("updates for every partial delta as it arrives", () => {
    const updateLastAssistantMessage = vi.fn();
    const finalizeLastAssistantMessage = vi.fn();
    for (const text of ["Hel", "lo", "!"]) {
      handleTextEvent(
        { session_id: CLAUDE_SESSION_ID, text, is_partial: true },
        CLAUDE_SESSION_ID,
        SESSION_ID,
        updateLastAssistantMessage,
        finalizeLastAssistantMessage
      );
    }

    expect(updateLastAssistantMessage).toHaveBeenNthCalledWith(
      1,
      SESSION_ID,
      "Hel"
    );
    expect(updateLastAssistantMessage).toHaveBeenNthCalledWith(
      2,
      SESSION_ID,
      "lo"
    );
    expect(updateLastAssistantMessage).toHaveBeenNthCalledWith(
      3,
      SESSION_ID,
      "!"
    );
    expect(finalizeLastAssistantMessage).not.toHaveBeenCalled();
  });

  it("finalizes complete text immediately", () => {
    const updateLastAssistantMessage = vi.fn();
    const finalizeLastAssistantMessage = vi.fn();
    handleTextEvent(
      { session_id: CLAUDE_SESSION_ID, text: "done", is_partial: false },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      updateLastAssistantMessage,
      finalizeLastAssistantMessage
    );
    expect(finalizeLastAssistantMessage).toHaveBeenCalledWith(
      SESSION_ID,
      "done"
    );
    expect(updateLastAssistantMessage).not.toHaveBeenCalled();
  });

  it("does nothing when session ID does not match", () => {
    const updateLastAssistantMessage = vi.fn();
    const finalizeLastAssistantMessage = vi.fn();
    handleTextEvent(
      { session_id: OTHER_SESSION_ID, text: "hello", is_partial: true },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      updateLastAssistantMessage,
      finalizeLastAssistantMessage
    );
    expect(updateLastAssistantMessage).not.toHaveBeenCalled();
    expect(finalizeLastAssistantMessage).not.toHaveBeenCalled();
  });
});

describe("handleToolCallEvent", () => {
  it("adds a tool_call message when session matches", () => {
    const addMsg = vi.fn();
    handleToolCallEvent(
      {
        session_id: CLAUDE_SESSION_ID,
        tool_id: "t1",
        tool_name: "Read",
        input: '{"path":"file.ts"}',
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      addMsg
    );
    expect(addMsg).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        kind: "tool_call",
        toolName: "Read",
        toolId: "t1",
        input: '{"path":"file.ts"}',
      })
    );
  });

  it("includes a timestamp in the message", () => {
    const addMsg = vi.fn();
    handleToolCallEvent(
      {
        session_id: CLAUDE_SESSION_ID,
        tool_id: "t1",
        tool_name: "Read",
        input: "{}",
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      addMsg
    );
    expect(addMsg.mock.calls[0][1].timestamp).toBeDefined();
  });

  it("does nothing when session does not match", () => {
    const addMsg = vi.fn();
    handleToolCallEvent(
      {
        session_id: OTHER_SESSION_ID,
        tool_id: "t1",
        tool_name: "Read",
        input: "{}",
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      addMsg
    );
    expect(addMsg).not.toHaveBeenCalled();
  });
});

describe("handleToolResultEvent", () => {
  it("adds a tool_result message when session matches", () => {
    const addMsg = vi.fn();
    handleToolResultEvent(
      {
        session_id: CLAUDE_SESSION_ID,
        tool_id: "t1",
        result: "success",
        is_error: false,
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      addMsg
    );
    expect(addMsg).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        kind: "tool_result",
        toolId: "t1",
        result: "success",
        isError: false,
      })
    );
  });

  it("passes is_error=true through", () => {
    const addMsg = vi.fn();
    handleToolResultEvent(
      {
        session_id: CLAUDE_SESSION_ID,
        tool_id: "t1",
        result: "fail",
        is_error: true,
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      addMsg
    );
    expect(addMsg.mock.calls[0][1].isError).toBe(true);
  });

  it("does nothing when session does not match", () => {
    const addMsg = vi.fn();
    handleToolResultEvent(
      {
        session_id: OTHER_SESSION_ID,
        tool_id: "t1",
        result: "x",
        is_error: false,
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      addMsg
    );
    expect(addMsg).not.toHaveBeenCalled();
  });
});

describe("handlePermissionRequestEvent", () => {
  it("adds a permission_request message when session matches", () => {
    const addMsg = vi.fn();
    handlePermissionRequestEvent(
      {
        session_id: CLAUDE_SESSION_ID,
        tool_name: "Bash",
        permission_message: "Allow rm -rf?",
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      addMsg
    );
    expect(addMsg).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        kind: "permission_request",
        toolName: "Bash",
        message: "Allow rm -rf?",
      })
    );
  });

  it("does nothing when session does not match", () => {
    const addMsg = vi.fn();
    handlePermissionRequestEvent(
      {
        session_id: OTHER_SESSION_ID,
        tool_name: "Bash",
        permission_message: "x",
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      addMsg
    );
    expect(addMsg).not.toHaveBeenCalled();
  });
});

describe("handleEndEvent", () => {
  it("clears stream state and returns lifecycle to idle when session matches", () => {
    const setLifecycle = vi.fn();
    const clearStreaming = vi.fn();
    const setClaudeSessionId = vi.fn();
    const setClaudeSessionIdRef = vi.fn();
    handleEndEvent(
      {
        session_id: CLAUDE_SESSION_ID,
        duration_ms: 1000,
        cost_usd: 0.01,
        num_turns: 5,
        result: "success",
        is_error: false,
        context_tokens: 1000,
        context_window: 200000,
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      setLifecycle,
      clearStreaming,
      setClaudeSessionId,
      setClaudeSessionIdRef
    );
    expect(clearStreaming).toHaveBeenCalledWith(SESSION_ID, true);
    expect(setClaudeSessionId).toHaveBeenCalledWith(SESSION_ID, null);
    expect(setClaudeSessionIdRef).toHaveBeenCalledWith(null);
    expect(setLifecycle).toHaveBeenCalledWith(SESSION_ID, "idle");
  });

  it("sets error lifecycle when Claude reports an error result", () => {
    const setLifecycle = vi.fn();
    const clearStreaming = vi.fn();
    const setClaudeSessionId = vi.fn();
    const setClaudeSessionIdRef = vi.fn();
    handleEndEvent(
      {
        session_id: CLAUDE_SESSION_ID,
        duration_ms: 1000,
        cost_usd: 0.01,
        num_turns: 5,
        result: "tool failed",
        is_error: true,
        context_tokens: 1000,
        context_window: 200000,
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      setLifecycle,
      clearStreaming,
      setClaudeSessionId,
      setClaudeSessionIdRef
    );
    expect(clearStreaming).toHaveBeenCalledWith(SESSION_ID, true);
    expect(setClaudeSessionId).toHaveBeenCalledWith(SESSION_ID, null);
    expect(setClaudeSessionIdRef).toHaveBeenCalledWith(null);
    expect(setLifecycle).toHaveBeenCalledWith(
      SESSION_ID,
      "error",
      "tool failed"
    );
  });

  it("does nothing when session does not match", () => {
    const setLifecycle = vi.fn();
    const clearStreaming = vi.fn();
    const setClaudeSessionId = vi.fn();
    const setClaudeSessionIdRef = vi.fn();
    handleEndEvent(
      {
        session_id: OTHER_SESSION_ID,
        duration_ms: 1000,
        cost_usd: 0.01,
        num_turns: 5,
        result: "success",
        is_error: false,
        context_tokens: 1000,
        context_window: 200000,
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      setLifecycle,
      clearStreaming,
      setClaudeSessionId,
      setClaudeSessionIdRef
    );
    expect(setLifecycle).not.toHaveBeenCalled();
    expect(clearStreaming).not.toHaveBeenCalled();
    expect(setClaudeSessionId).not.toHaveBeenCalled();
    expect(setClaudeSessionIdRef).not.toHaveBeenCalled();
  });
});

describe("handleErrorEvent", () => {
  it("adds an error message when session matches", () => {
    const addMsg = vi.fn();
    const setLifecycle = vi.fn();
    const clearStreaming = vi.fn();
    handleErrorEvent(
      { session_id: CLAUDE_SESSION_ID, error: "something broke" },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      addMsg,
      setLifecycle,
      clearStreaming
    );
    expect(clearStreaming).toHaveBeenCalledWith(SESSION_ID, true);
    expect(setLifecycle).toHaveBeenCalledWith(
      SESSION_ID,
      "error",
      "something broke"
    );
    expect(addMsg).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        kind: "error",
        message: "something broke",
      })
    );
  });

  it("does nothing when session does not match", () => {
    const addMsg = vi.fn();
    const setLifecycle = vi.fn();
    const clearStreaming = vi.fn();
    handleErrorEvent(
      { session_id: OTHER_SESSION_ID, error: "x" },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      addMsg,
      setLifecycle,
      clearStreaming
    );
    expect(addMsg).not.toHaveBeenCalled();
    expect(setLifecycle).not.toHaveBeenCalled();
    expect(clearStreaming).not.toHaveBeenCalled();
  });
});

// --- Session lifecycle functions ---

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: SESSION_ID,
    scope: "task",
    entityId: "task-1",
    label: "Test Task",
    messages: [],
    status: "open",
    claudeSessionId: null,
    claudeConversationId: null,
    contextSummary: null,
    ...overrides,
  };
}

describe("doStartSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("generates a backend session ID and sets it", async () => {
    const deps = {
      setClaudeSessionId: vi.fn(),
      setClaudeSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(makeSession(), SESSION_ID, deps);

    expect(deps.setClaudeSessionId).toHaveBeenCalledWith(
      SESSION_ID,
      expect.stringMatching(/^scoped-session-1-\d+$/)
    );
    expect(deps.setClaudeSessionIdRef).toHaveBeenCalledWith(
      expect.stringMatching(/^scoped-session-1-\d+$/)
    );
    expect(deps.setSessionLifecycle).toHaveBeenCalledWith(
      SESSION_ID,
      "starting"
    );
    expect(deps.setSessionLifecycle).toHaveBeenLastCalledWith(
      SESSION_ID,
      "idle"
    );
  });

  it("calls createClaudeSession with working directory", async () => {
    const deps = {
      setClaudeSessionId: vi.fn(),
      setClaudeSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(makeSession(), SESSION_ID, deps);

    expect(mockedCommands.createClaudeSession).toHaveBeenCalledWith(
      expect.stringMatching(/^scoped-/),
      "/test/project",
      null,
      null
    );
  });

  it("uses the project path captured on the chat session", async () => {
    const deps = {
      setClaudeSessionId: vi.fn(),
      setClaudeSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(
      makeSession({ projectPath: "/captured/project" }),
      SESSION_ID,
      deps
    );

    expect(mockedCommands.getCurrentProjectPath).not.toHaveBeenCalled();
    expect(mockedCommands.createClaudeSession).toHaveBeenCalledWith(
      expect.stringMatching(/^scoped-/),
      "/captured/project",
      null,
      null
    );
  });

  it("adds user message when provided", async () => {
    const deps = {
      setClaudeSessionId: vi.fn(),
      setClaudeSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(makeSession(), SESSION_ID, deps, "Hello");

    expect(deps.addMessage).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        kind: "user",
        text: "Hello",
      })
    );
    expect(deps.setSessionLifecycle).toHaveBeenLastCalledWith(
      SESSION_ID,
      "streaming"
    );
  });

  it("does not add user message when not provided", async () => {
    const deps = {
      setClaudeSessionId: vi.fn(),
      setClaudeSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(makeSession(), SESSION_ID, deps);

    expect(deps.addMessage).not.toHaveBeenCalled();
  });

  it("uses existing contextSummary without fetching", async () => {
    const { buildContextSummary } = await import("../utils/chatContext");
    const deps = {
      setClaudeSessionId: vi.fn(),
      setClaudeSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(
      makeSession({ contextSummary: "[Context: Task]\nTask: X" }),
      SESSION_ID,
      deps,
      "Help"
    );

    expect(buildContextSummary).not.toHaveBeenCalled();
    expect(deps.setContextSummary).not.toHaveBeenCalled();
  });

  it("fetches and stores context when contextSummary is null", async () => {
    const { buildContextSummary } = await import("../utils/chatContext");
    vi.mocked(buildContextSummary).mockResolvedValueOnce(
      "[Context: Task]\nTask: Fetched"
    );

    const deps = {
      setClaudeSessionId: vi.fn(),
      setClaudeSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(makeSession(), SESSION_ID, deps, "Go");

    expect(buildContextSummary).toHaveBeenCalledWith("task", "task-1");
    expect(deps.setContextSummary).toHaveBeenCalledWith(
      SESSION_ID,
      "[Context: Task]\nTask: Fetched"
    );
  });

  it("passes resumeId when session has claudeConversationId", async () => {
    const deps = {
      setClaudeSessionId: vi.fn(),
      setClaudeSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(
      makeSession({ claudeConversationId: "conv-xyz" }),
      SESSION_ID,
      deps
    );

    expect(mockedCommands.createClaudeSession).toHaveBeenCalledWith(
      expect.any(String),
      "/test/project",
      null,
      "conv-xyz"
    );
    expect(deps.setSessionLifecycle).toHaveBeenCalledWith(
      SESSION_ID,
      "resuming"
    );
  });

  it("passes null workingDir when getCurrentProjectPath fails", async () => {
    mockedCommands.getCurrentProjectPath.mockResolvedValueOnce({
      status: "error",
      error: "no project",
    } as never);

    const deps = {
      setClaudeSessionId: vi.fn(),
      setClaudeSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(makeSession(), SESSION_ID, deps);

    expect(mockedCommands.createClaudeSession).toHaveBeenCalledWith(
      expect.any(String),
      null,
      null,
      null
    );
  });

  it("passes initial prompt with context when user message provided", async () => {
    const deps = {
      setClaudeSessionId: vi.fn(),
      setClaudeSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(
      makeSession({ contextSummary: "[Context]" }),
      SESSION_ID,
      deps,
      "Question"
    );

    expect(mockedCommands.createClaudeSession).toHaveBeenCalledWith(
      expect.any(String),
      "/test/project",
      "[Context]\n\n---\n\nQuestion",
      null
    );
  });

  it("sets error lifecycle and clears backend id when createClaudeSession fails", async () => {
    mockedCommands.createClaudeSession.mockResolvedValueOnce({
      status: "error",
      error: { SpawnFailed: "claude missing" },
    } as never);
    const deps = {
      setClaudeSessionId: vi.fn(),
      setClaudeSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(makeSession(), SESSION_ID, deps);

    expect(deps.setClaudeSessionId).toHaveBeenLastCalledWith(SESSION_ID, null);
    expect(deps.setClaudeSessionIdRef).toHaveBeenLastCalledWith(null);
    expect(deps.setSessionLifecycle).toHaveBeenLastCalledWith(
      SESSION_ID,
      "error",
      "claude missing"
    );
  });

  it("does not call Sacrum live chat commands for local session creation", async () => {
    const deps = {
      setClaudeSessionId: vi.fn(),
      setClaudeSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(makeSession(), SESSION_ID, deps, "Hello");

    expect(mockedCommands.createChatSession).not.toHaveBeenCalled();
    expect(mockedCommands.sendChatMessage).not.toHaveBeenCalled();
    expect(mockedCommands.setActiveChatSessionId).not.toHaveBeenCalled();
  });
});

describe("doSendMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds user message and calls sendClaudeMessage", async () => {
    const deps = {
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
      setClaudeSessionId: vi.fn(),
      setClaudeSessionIdRef: vi.fn(),
    };

    await doSendMessage(CLAUDE_SESSION_ID, SESSION_ID, "Hello", deps);

    expect(deps.setSessionLifecycle).toHaveBeenNthCalledWith(
      1,
      SESSION_ID,
      "sending"
    );
    expect(deps.addMessage).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        kind: "user",
        text: "Hello",
      })
    );
    expect(mockedCommands.sendClaudeMessage).toHaveBeenCalledWith(
      CLAUDE_SESSION_ID,
      "Hello"
    );
    expect(deps.setSessionLifecycle).toHaveBeenNthCalledWith(
      2,
      SESSION_ID,
      "streaming"
    );
  });

  it("message includes a timestamp", async () => {
    const deps = {
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doSendMessage(CLAUDE_SESSION_ID, SESSION_ID, "Hi", deps);

    expect(deps.addMessage.mock.calls[0][1].timestamp).toBeDefined();
  });

  it("sets error lifecycle when sendClaudeMessage fails", async () => {
    mockedCommands.sendClaudeMessage.mockResolvedValueOnce({
      status: "error",
      error: { SendFailed: "pipe closed" },
    } as never);
    const deps = {
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
      setClaudeSessionId: vi.fn(),
      setClaudeSessionIdRef: vi.fn(),
    };

    await doSendMessage(CLAUDE_SESSION_ID, SESSION_ID, "Hi", deps);

    expect(deps.setSessionLifecycle).toHaveBeenLastCalledWith(
      SESSION_ID,
      "error",
      "pipe closed"
    );
  });

  it("clears stale backend id when sendClaudeMessage reports not found", async () => {
    mockedCommands.sendClaudeMessage.mockResolvedValueOnce({
      status: "error",
      error: { SessionNotFound: "missing" },
    } as never);
    const deps = {
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
      setClaudeSessionId: vi.fn(),
      setClaudeSessionIdRef: vi.fn(),
    };

    await doSendMessage(CLAUDE_SESSION_ID, SESSION_ID, "Hi", deps);

    expect(deps.setClaudeSessionId).toHaveBeenCalledWith(SESSION_ID, null);
    expect(deps.setClaudeSessionIdRef).toHaveBeenCalledWith(null);
    expect(deps.setSessionLifecycle).toHaveBeenLastCalledWith(
      SESSION_ID,
      "error",
      "missing"
    );
  });

  it("does not clear backend id for non-SessionNotFound errors containing not found", async () => {
    mockedCommands.sendClaudeMessage.mockResolvedValueOnce({
      status: "error",
      error: { SendFailed: "File not found: /project/config.ts" },
    } as never);
    const deps = {
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
      setClaudeSessionId: vi.fn(),
      setClaudeSessionIdRef: vi.fn(),
    };

    await doSendMessage(CLAUDE_SESSION_ID, SESSION_ID, "Hi", deps);

    expect(deps.setClaudeSessionId).not.toHaveBeenCalled();
    expect(deps.setClaudeSessionIdRef).not.toHaveBeenCalled();
    expect(deps.setSessionLifecycle).toHaveBeenLastCalledWith(
      SESSION_ID,
      "error",
      "File not found: /project/config.ts"
    );
  });

  it("does not call Sacrum live chat commands when sending local messages", async () => {
    const deps = {
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doSendMessage(CLAUDE_SESSION_ID, SESSION_ID, "Hi", deps);

    expect(mockedCommands.sendChatMessage).not.toHaveBeenCalled();
    expect(mockedCommands.createChatSession).not.toHaveBeenCalled();
  });
});

describe("doCloseSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls closeClaudeSession and marks session closed", async () => {
    const deps = {
      markSessionClosed: vi.fn(),
      setSessionLifecycle: vi.fn(),
      setClaudeSessionId: vi.fn(),
      setClaudeSessionIdRef: vi.fn(),
    };

    const closed = await doCloseSession(CLAUDE_SESSION_ID, SESSION_ID, deps);

    expect(mockedCommands.closeClaudeSession).toHaveBeenCalledWith(
      CLAUDE_SESSION_ID
    );
    expect(closed).toBe(true);
    expect(deps.setSessionLifecycle).toHaveBeenCalledWith(
      SESSION_ID,
      "closing"
    );
    expect(deps.markSessionClosed).toHaveBeenCalledWith(SESSION_ID);
    expect(deps.setClaudeSessionId).toHaveBeenCalledWith(SESSION_ID, null);
    expect(deps.setClaudeSessionIdRef).toHaveBeenCalledWith(null);
  });

  it("does not call markSessionClosed when sessionId is null", async () => {
    const deps = {
      markSessionClosed: vi.fn(),
      setSessionLifecycle: vi.fn(),
      setClaudeSessionId: vi.fn(),
      setClaudeSessionIdRef: vi.fn(),
    };

    const closed = await doCloseSession(CLAUDE_SESSION_ID, null, deps);

    expect(mockedCommands.closeClaudeSession).toHaveBeenCalledWith(
      CLAUDE_SESSION_ID
    );
    expect(closed).toBe(true);
    expect(deps.markSessionClosed).not.toHaveBeenCalled();
  });

  it("treats missing backend session as already closed", async () => {
    mockedCommands.closeClaudeSession.mockResolvedValueOnce({
      status: "error",
      error: { SessionNotFound: "missing" },
    } as never);
    const deps = {
      markSessionClosed: vi.fn(),
      setSessionLifecycle: vi.fn(),
      setClaudeSessionId: vi.fn(),
      setClaudeSessionIdRef: vi.fn(),
    };

    const closed = await doCloseSession(CLAUDE_SESSION_ID, SESSION_ID, deps);

    expect(closed).toBe(true);
    expect(deps.markSessionClosed).toHaveBeenCalledWith(SESSION_ID);
    expect(deps.setClaudeSessionId).toHaveBeenCalledWith(SESSION_ID, null);
    expect(deps.setClaudeSessionIdRef).toHaveBeenCalledWith(null);
    expect(deps.setSessionLifecycle).not.toHaveBeenCalledWith(
      SESSION_ID,
      "error",
      "missing"
    );
  });

  it("sets error lifecycle when closeClaudeSession fails for another reason", async () => {
    mockedCommands.closeClaudeSession.mockResolvedValueOnce({
      status: "error",
      error: { SendFailed: "pipe closed" },
    } as never);
    const deps = {
      markSessionClosed: vi.fn(),
      setSessionLifecycle: vi.fn(),
      setClaudeSessionId: vi.fn(),
      setClaudeSessionIdRef: vi.fn(),
    };

    const closed = await doCloseSession(CLAUDE_SESSION_ID, SESSION_ID, deps);

    expect(closed).toBe(false);
    expect(deps.markSessionClosed).not.toHaveBeenCalled();
    expect(deps.setClaudeSessionId).not.toHaveBeenCalled();
    expect(deps.setClaudeSessionIdRef).not.toHaveBeenCalled();
    expect(deps.setSessionLifecycle).toHaveBeenLastCalledWith(
      SESSION_ID,
      "error",
      "pipe closed"
    );
  });
});
