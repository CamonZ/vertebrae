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
  handleWarningEvent,
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
  it("stores cached-token-inclusive input context and computes max from the frontend lookup table", () => {
    const setUsage = vi.fn();
    handleUsageEvent(
      {
        session_id: CLAUDE_SESSION_ID,
        model: "claude-opus-4-7-20250115",
        context_tokens: 100_050,
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
        used: 100_050,
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

describe("handleWarningEvent", () => {
  it("adds a warning message when session matches", () => {
    const addMsg = vi.fn();
    handleWarningEvent(
      {
        session_id: CLAUDE_SESSION_ID,
        warning: "Unsupported model; using sonnet.",
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      addMsg
    );
    expect(addMsg).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        kind: "warning",
        message: "Unsupported model; using sonnet.",
      })
    );
  });

  it("ignores warnings for a different session", () => {
    const addMsg = vi.fn();
    handleWarningEvent(
      {
        session_id: OTHER_SESSION_ID,
        warning: "Unsupported model; using sonnet.",
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      addMsg
    );
    expect(addMsg).not.toHaveBeenCalled();
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
        parent_tool_use_id: null,
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
        parent_tool_use_id: null,
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
        parent_tool_use_id: null,
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
        parent_tool_use_id: null,
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
        parent_tool_use_id: null,
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
        parent_tool_use_id: null,
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

  it("leaves token usage unchanged when session-end summary reports different context tokens", () => {
    let tokenUsage: { used: number; max: number } | undefined;
    const setUsage = vi.fn(
      (
        _sessionId: string,
        _model: string,
        usage: { used: number; max: number }
      ) => {
        tokenUsage = usage;
      }
    );

    handleUsageEvent(
      {
        session_id: CLAUDE_SESSION_ID,
        model: "claude-sonnet-4.5",
        context_tokens: 100_050,
        context_window: 200_000,
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      setUsage
    );

    const setLifecycle = vi.fn();
    handleEndEvent(
      {
        session_id: CLAUDE_SESSION_ID,
        duration_ms: 1000,
        cost_usd: 0.01,
        num_turns: 5,
        result: "success",
        is_error: false,
        context_tokens: 1,
        context_window: 1,
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      setLifecycle,
      vi.fn(),
      vi.fn(),
      vi.fn()
    );

    expect(setUsage).toHaveBeenCalledOnce();
    expect(tokenUsage).toEqual({ used: 100_050, max: 200_000 });
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

    expect(mockedCommands.createClaudeSession).toHaveBeenCalledWith({
      session_id: expect.stringMatching(/^scoped-/),
      working_dir: "/test/project",
      initial_prompt: null,
      resume_session_id: null,
      model_id: null,
      permission_mode: "default",
    });
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
    expect(mockedCommands.createClaudeSession).toHaveBeenCalledWith({
      session_id: expect.stringMatching(/^scoped-/),
      working_dir: "/captured/project",
      initial_prompt: null,
      resume_session_id: null,
      model_id: null,
      permission_mode: "default",
    });
  });

  it("fetches the current project path when the captured project path is null", async () => {
    const deps = {
      setClaudeSessionId: vi.fn(),
      setClaudeSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(makeSession({ projectPath: null }), SESSION_ID, deps);

    expect(mockedCommands.getCurrentProjectPath).toHaveBeenCalled();
    expect(mockedCommands.createClaudeSession).toHaveBeenCalledWith({
      session_id: expect.stringMatching(/^scoped-/),
      working_dir: "/test/project",
      initial_prompt: null,
      resume_session_id: null,
      model_id: null,
      permission_mode: "default",
    });
  });

  it("passes the selected model id when the session has one", async () => {
    const deps = {
      setClaudeSessionId: vi.fn(),
      setClaudeSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(
      makeSession({ selectedModelId: "opus" }),
      SESSION_ID,
      deps
    );

    expect(mockedCommands.createClaudeSession).toHaveBeenCalledWith({
      session_id: expect.stringMatching(/^scoped-/),
      working_dir: "/test/project",
      initial_prompt: null,
      resume_session_id: null,
      model_id: "opus",
      permission_mode: "default",
    });
  });

  it("passes the selected permission mode when starting", async () => {
    const deps = {
      setClaudeSessionId: vi.fn(),
      setClaudeSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(
      makeSession({ permissionMode: "auto" }),
      SESSION_ID,
      deps
    );

    expect(mockedCommands.createClaudeSession).toHaveBeenCalledWith({
      session_id: expect.stringMatching(/^scoped-/),
      working_dir: "/test/project",
      initial_prompt: null,
      resume_session_id: null,
      model_id: null,
      permission_mode: "auto",
    });
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

  it("starts without fetching, storing, or injecting scoped context", async () => {
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

    expect(mockedCommands.getCurrentProject).not.toHaveBeenCalled();
    expect(mockedCommands.getTask).not.toHaveBeenCalled();
    expect(mockedCommands.getTaskExecutions).not.toHaveBeenCalled();
    expect(mockedCommands.getWorkflowWithTasks).not.toHaveBeenCalled();
    expect(mockedCommands.getStep).not.toHaveBeenCalled();
    expect(deps.setContextSummary).not.toHaveBeenCalled();
    expect(mockedCommands.createClaudeSession).toHaveBeenCalledWith({
      session_id: expect.any(String),
      working_dir: "/test/project",
      initial_prompt: "Help",
      resume_session_id: null,
      model_id: null,
      permission_mode: "default",
    });
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

    expect(mockedCommands.createClaudeSession).toHaveBeenCalledWith({
      session_id: expect.any(String),
      working_dir: "/test/project",
      initial_prompt: null,
      resume_session_id: "conv-xyz",
      model_id: null,
      permission_mode: "default",
    });
    expect(deps.setSessionLifecycle).toHaveBeenCalledWith(
      SESSION_ID,
      "resuming"
    );
  });

  it("does not pass selected model id when resuming a Claude conversation", async () => {
    const deps = {
      setClaudeSessionId: vi.fn(),
      setClaudeSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(
      makeSession({
        claudeConversationId: "conv-xyz",
        selectedModelId: "opus",
      }),
      SESSION_ID,
      deps
    );

    expect(mockedCommands.createClaudeSession).toHaveBeenCalledWith({
      session_id: expect.any(String),
      working_dir: "/test/project",
      initial_prompt: null,
      resume_session_id: "conv-xyz",
      model_id: null,
      permission_mode: "default",
    });
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

    expect(mockedCommands.createClaudeSession).toHaveBeenCalledWith({
      session_id: expect.any(String),
      working_dir: null,
      initial_prompt: null,
      resume_session_id: null,
      model_id: null,
      permission_mode: "default",
    });
  });

  it("passes the user message as the initial prompt without context", async () => {
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

    expect(mockedCommands.createClaudeSession).toHaveBeenCalledWith({
      session_id: expect.any(String),
      working_dir: "/test/project",
      initial_prompt: "Question",
      resume_session_id: null,
      model_id: null,
      permission_mode: "default",
    });
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
