import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleInitEvent,
  handleUsageEvent,
  handleTextEvent,
  handleToolCallEvent,
  handleToolResultEvent,
  handleSacrumPermissionRequestEvent,
  handleEndEvent,
  handleErrorEvent,
  handleWarningEvent,
  doStartSession,
  doSendMessage,
  doCloseSession,
} from "./useLocalChat";
import {
  getLocalChatLifecycle,
  useChatStore,
  type ChatSession,
} from "../stores/chatStore";
import { commands } from "../bindings";

vi.mock("../bindings", () => ({
  commands: {
    getCurrentProjectPath: vi.fn().mockResolvedValue({
      status: "ok",
      data: "/test/project",
    }),
    createLocalChatSession: vi.fn().mockResolvedValue({ status: "ok" }),
    inferLocalChatSessionTitle: vi.fn().mockResolvedValue({
      status: "ok",
      data: {
        title: "Inferred Title",
        confidence: 0.91,
        sufficient_signal: true,
      },
    }),
    sendLocalChatMessage: vi.fn().mockResolvedValue({ status: "ok" }),
    closeLocalChatSession: vi.fn().mockResolvedValue({ status: "ok" }),
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

function deferredCommandResult() {
  let resolve!: (value: { status: "ok" }) => void;
  const promise = new Promise<{ status: "ok" }>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("handleInitEvent", () => {
  it("calls setProviderResumeId and setSessionModel when session matches", () => {
    const setConvId = vi.fn();
    const setModel = vi.fn();
    handleInitEvent(
      {
        backend_session_id: CLAUDE_SESSION_ID,
        harness: "claude",
        provider_resume_id: "conv-abc",
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
        backend_session_id: OTHER_SESSION_ID,
        harness: "claude",
        provider_resume_id: "conv-abc",
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

  it("does not call setProviderResumeId when conversation ID is null", () => {
    const setConvId = vi.fn();
    const setModel = vi.fn();
    handleInitEvent(
      {
        backend_session_id: CLAUDE_SESSION_ID,
        harness: "claude",
        provider_resume_id: null,
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
        backend_session_id: CLAUDE_SESSION_ID,
        harness: "claude",
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
        backend_session_id: CLAUDE_SESSION_ID,
        harness: "claude",
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
        backend_session_id: OTHER_SESSION_ID,
        harness: "claude",
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
        backend_session_id: CLAUDE_SESSION_ID,
        harness: "claude",
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
        backend_session_id: OTHER_SESSION_ID,
        harness: "claude",
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
      {
        backend_session_id: CLAUDE_SESSION_ID,
        harness: "claude",
        text: "hello",
        is_partial: true,
        parent_tool_use_id: null,
      },
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
        {
          backend_session_id: CLAUDE_SESSION_ID,
          harness: "claude",
          text,
          is_partial: true,
          parent_tool_use_id: null,
        },
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
      {
        backend_session_id: CLAUDE_SESSION_ID,
        harness: "claude",
        text: "done",
        is_partial: false,
        parent_tool_use_id: null,
      },
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
      {
        backend_session_id: OTHER_SESSION_ID,
        harness: "claude",
        text: "hello",
        is_partial: true,
        parent_tool_use_id: null,
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      updateLastAssistantMessage,
      finalizeLastAssistantMessage
    );
    expect(updateLastAssistantMessage).not.toHaveBeenCalled();
    expect(finalizeLastAssistantMessage).not.toHaveBeenCalled();
  });

  it("adds parent-linked assistant text as a child transcript message", () => {
    const updateLastAssistantMessage = vi.fn();
    const finalizeLastAssistantMessage = vi.fn();
    const addMessage = vi.fn();
    handleTextEvent(
      {
        backend_session_id: CLAUDE_SESSION_ID,
        harness: "codex",
        text: "child agent",
        is_partial: true,
        parent_tool_use_id: "agent-tool",
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      updateLastAssistantMessage,
      finalizeLastAssistantMessage,
      addMessage
    );

    expect(addMessage).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        kind: "assistant",
        text: "child agent",
        parentToolUseId: "agent-tool",
      })
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
        backend_session_id: CLAUDE_SESSION_ID,
        harness: "claude",
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
        backend_session_id: CLAUDE_SESSION_ID,
        harness: "claude",
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
        backend_session_id: OTHER_SESSION_ID,
        harness: "claude",
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
        backend_session_id: CLAUDE_SESSION_ID,
        harness: "claude",
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
        backend_session_id: CLAUDE_SESSION_ID,
        harness: "claude",
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
        backend_session_id: OTHER_SESSION_ID,
        harness: "claude",
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

describe("handleSacrumPermissionRequestEvent", () => {
  it("adds a permission_request message when session matches", () => {
    const addMsg = vi.fn();
    handleSacrumPermissionRequestEvent(
      {
        request_id: "request-1",
        session_id: CLAUDE_SESSION_ID,
        tool_name: "Bash",
        tool_use_id: "tool-use-1",
        input: { command: "rm -rf?" },
        message: "Allow rm -rf?",
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      addMsg
    );
    expect(addMsg).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        kind: "permission_request",
        requestId: "request-1",
        toolName: "Bash",
        message: "Allow rm -rf?",
        input: JSON.stringify({ command: "rm -rf?" }, null, 2),
      })
    );
  });

  it("does nothing when session does not match", () => {
    const addMsg = vi.fn();
    handleSacrumPermissionRequestEvent(
      {
        request_id: "request-1",
        session_id: OTHER_SESSION_ID,
        tool_name: "Bash",
        tool_use_id: "tool-use-1",
        input: {},
        message: "x",
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
    const setBackendSessionId = vi.fn();
    const setBackendSessionIdRef = vi.fn();
    handleEndEvent(
      {
        backend_session_id: CLAUDE_SESSION_ID,
        harness: "claude",
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
      setBackendSessionId,
      setBackendSessionIdRef
    );
    expect(clearStreaming).toHaveBeenCalledWith(SESSION_ID, true);
    expect(setBackendSessionId).toHaveBeenCalledWith(SESSION_ID, null);
    expect(setBackendSessionIdRef).toHaveBeenCalledWith(null);
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
        backend_session_id: CLAUDE_SESSION_ID,
        harness: "claude",
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
        backend_session_id: CLAUDE_SESSION_ID,
        harness: "claude",
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
    const setBackendSessionId = vi.fn();
    const setBackendSessionIdRef = vi.fn();
    handleEndEvent(
      {
        backend_session_id: CLAUDE_SESSION_ID,
        harness: "claude",
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
      setBackendSessionId,
      setBackendSessionIdRef
    );
    expect(clearStreaming).toHaveBeenCalledWith(SESSION_ID, true);
    expect(setBackendSessionId).toHaveBeenCalledWith(SESSION_ID, null);
    expect(setBackendSessionIdRef).toHaveBeenCalledWith(null);
    expect(setLifecycle).toHaveBeenCalledWith(
      SESSION_ID,
      "error",
      "tool failed"
    );
  });

  it("does nothing when session does not match", () => {
    const setLifecycle = vi.fn();
    const clearStreaming = vi.fn();
    const setBackendSessionId = vi.fn();
    const setBackendSessionIdRef = vi.fn();
    handleEndEvent(
      {
        backend_session_id: OTHER_SESSION_ID,
        harness: "claude",
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
      setBackendSessionId,
      setBackendSessionIdRef
    );
    expect(setLifecycle).not.toHaveBeenCalled();
    expect(clearStreaming).not.toHaveBeenCalled();
    expect(setBackendSessionId).not.toHaveBeenCalled();
    expect(setBackendSessionIdRef).not.toHaveBeenCalled();
  });
});

describe("handleErrorEvent", () => {
  it("adds an error message when session matches", () => {
    const addMsg = vi.fn();
    const setLifecycle = vi.fn();
    const clearStreaming = vi.fn();
    handleErrorEvent(
      {
        backend_session_id: CLAUDE_SESSION_ID,
        harness: "claude",
        error: "something broke",
      },
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
      {
        backend_session_id: OTHER_SESSION_ID,
        harness: "claude",
        error: "x",
      },
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
    label: "Test Task",
    messages: [],
    status: "open",
    harness: "claude",
    backendSessionId: null,
    providerResumeId: null,
    ...overrides,
  };
}

describe("doStartSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("generates a backend session ID and sets it", async () => {
    const deps = {
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(makeSession(), SESSION_ID, deps);

    expect(deps.setBackendSessionId).toHaveBeenCalledWith(
      SESSION_ID,
      expect.stringMatching(/^local-session-1-\d+$/)
    );
    expect(deps.setBackendSessionIdRef).toHaveBeenCalledWith(
      expect.stringMatching(/^local-session-1-\d+$/)
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

  it("calls createLocalChatSession with working directory", async () => {
    const deps = {
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(makeSession(), SESSION_ID, deps);

    expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith({
      backend_session_id: expect.stringMatching(/^local-/),
      harness: "claude",
      working_dir: "/test/project",
      initial_prompt: null,
      provider_resume_id: null,
      model_id: null,
      reasoning_effort: null,
      permission_mode: "default",
    });
  });

  it("uses the project path captured on the chat session", async () => {
    const deps = {
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
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
    expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith({
      backend_session_id: expect.stringMatching(/^local-/),
      harness: "claude",
      working_dir: "/captured/project",
      initial_prompt: null,
      provider_resume_id: null,
      model_id: null,
      reasoning_effort: null,
      permission_mode: "default",
    });
  });

  it("fetches the current project path when the captured project path is null", async () => {
    const deps = {
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(makeSession({ projectPath: null }), SESSION_ID, deps);

    expect(mockedCommands.getCurrentProjectPath).toHaveBeenCalled();
    expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith({
      backend_session_id: expect.stringMatching(/^local-/),
      harness: "claude",
      working_dir: "/test/project",
      initial_prompt: null,
      provider_resume_id: null,
      model_id: null,
      reasoning_effort: null,
      permission_mode: "default",
    });
  });

  it("passes the selected model id when the session has one", async () => {
    const deps = {
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(
      makeSession({ selectedModelId: "opus" }),
      SESSION_ID,
      deps
    );

    expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith({
      backend_session_id: expect.stringMatching(/^local-/),
      harness: "claude",
      working_dir: "/test/project",
      initial_prompt: null,
      provider_resume_id: null,
      model_id: "opus",
      reasoning_effort: null,
      permission_mode: "default",
    });
  });

  it("passes selected Codex harness and model id to the neutral create command", async () => {
    const deps = {
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(
      makeSession({
        harness: "codex",
        selectedModelId: "catalog-codex-alt",
      }),
      SESSION_ID,
      deps
    );

    expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith({
      backend_session_id: expect.stringMatching(/^local-/),
      harness: "codex",
      working_dir: "/test/project",
      initial_prompt: null,
      provider_resume_id: null,
      model_id: "catalog-codex-alt",
      reasoning_effort: null,
      permission_mode: "default",
    });
  });

  it("passes selected Codex reasoning effort to the neutral create command", async () => {
    const deps = {
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(
      makeSession({
        harness: "codex",
        selectedModelId: "gpt-5.5",
        selectedReasoningEffort: "high",
      }),
      SESSION_ID,
      deps
    );

    expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith({
      backend_session_id: expect.stringMatching(/^local-/),
      harness: "codex",
      working_dir: "/test/project",
      initial_prompt: null,
      provider_resume_id: null,
      model_id: "gpt-5.5",
      reasoning_effort: "high",
      permission_mode: "default",
    });
  });

  it("passes the selected permission mode when starting", async () => {
    const deps = {
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(
      makeSession({ permissionMode: "auto" }),
      SESSION_ID,
      deps
    );

    expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith({
      backend_session_id: expect.stringMatching(/^local-/),
      harness: "claude",
      working_dir: "/test/project",
      initial_prompt: null,
      provider_resume_id: null,
      model_id: null,
      reasoning_effort: null,
      permission_mode: "auto",
    });
  });

  it("adds user message when provided", async () => {
    const deps = {
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
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

  it("infers a title for a new automatic-label session from the first prompt", async () => {
    const deps = {
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
      addMessage: vi.fn(),
      setSessionTitleCandidate: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(
      makeSession({ label: "New Chat", harness: "codex" }),
      SESSION_ID,
      deps,
      "Implement title inference"
    );

    expect(mockedCommands.inferLocalChatSessionTitle).toHaveBeenCalledWith({
      harness: "codex",
      initial_prompts: ["Implement title inference"],
      working_dir: "/test/project",
    });
    await vi.waitFor(() =>
      expect(deps.setSessionTitleCandidate).toHaveBeenCalledWith(
        SESSION_ID,
        {
          title: "Inferred Title",
          confidence: 0.91,
          sufficientSignal: true,
          userMessageCount: 1,
        }
      )
    );
  });

  it("passes an insufficient first-message candidate without freezing a title", async () => {
    mockedCommands.inferLocalChatSessionTitle.mockResolvedValueOnce({
      status: "ok",
      data: {
        title: null,
        confidence: 0.12,
        sufficient_signal: false,
      },
    });
    const deps = {
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
      addMessage: vi.fn(),
      setSessionTitleCandidate: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(
      makeSession({ label: "New Chat", harness: "claude" }),
      SESSION_ID,
      deps,
      "Hello"
    );

    expect(mockedCommands.inferLocalChatSessionTitle).toHaveBeenCalledWith({
      harness: "claude",
      initial_prompts: ["Hello"],
      working_dir: "/test/project",
    });
    await vi.waitFor(() =>
      expect(deps.setSessionTitleCandidate).toHaveBeenCalledWith(SESSION_ID, {
        title: null,
        confidence: 0.12,
        sufficientSignal: false,
        userMessageCount: 1,
      })
    );
  });

  it("retries title inference with the first two user messages after low confidence", async () => {
    const deps = {
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
      addMessage: vi.fn(),
      setSessionTitleCandidate: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(
      makeSession({
        label: "New Chat",
        messages: [
          {
            kind: "user",
            text: "Hello",
            timestamp: "2026-01-01T00:00:00Z",
          },
        ],
        titleStatus: "low_confidence",
        titleConfidence: 0.12,
        titleUserMessageCount: 1,
      }),
      SESSION_ID,
      deps,
      "Implement session title confidence"
    );

    expect(mockedCommands.inferLocalChatSessionTitle).toHaveBeenCalledWith({
      harness: "claude",
      initial_prompts: ["Hello", "Implement session title confidence"],
      working_dir: "/test/project",
    });
    await vi.waitFor(() =>
      expect(deps.setSessionTitleCandidate).toHaveBeenCalledWith(
        SESSION_ID,
        expect.objectContaining({
          title: "Inferred Title",
          userMessageCount: 2,
        })
      )
    );
  });

  it("does not infer a title for custom-labeled sessions", async () => {
    const deps = {
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
      addMessage: vi.fn(),
      setSessionTitleCandidate: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(makeSession({ label: "Task Chat" }), SESSION_ID, deps, "Help");

    expect(mockedCommands.inferLocalChatSessionTitle).not.toHaveBeenCalled();
    expect(deps.setSessionTitleCandidate).not.toHaveBeenCalled();
  });

  it("does not add user message when not provided", async () => {
    const deps = {
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(makeSession(), SESSION_ID, deps);

    expect(deps.addMessage).not.toHaveBeenCalled();
  });

  it("starts without fetching, storing, or injecting local context", async () => {
    const deps = {
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(makeSession(), SESSION_ID, deps, "Help");

    expect(mockedCommands.getCurrentProject).not.toHaveBeenCalled();
    expect(mockedCommands.getTask).not.toHaveBeenCalled();
    expect(mockedCommands.getTaskExecutions).not.toHaveBeenCalled();
    expect(mockedCommands.getWorkflowWithTasks).not.toHaveBeenCalled();
    expect(mockedCommands.getStep).not.toHaveBeenCalled();
    expect(deps.setContextSummary).not.toHaveBeenCalled();
    expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith({
      backend_session_id: expect.any(String),
      harness: "claude",
      working_dir: "/test/project",
      initial_prompt: "Help",
      provider_resume_id: null,
      model_id: null,
      reasoning_effort: null,
      permission_mode: "default",
    });
  });

  it("passes resumeId when session has providerResumeId", async () => {
    const deps = {
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(
      makeSession({ providerResumeId: "conv-xyz" }),
      SESSION_ID,
      deps
    );

    expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith({
      backend_session_id: expect.any(String),
      harness: "claude",
      working_dir: "/test/project",
      initial_prompt: null,
      provider_resume_id: "conv-xyz",
      model_id: null,
      reasoning_effort: null,
      permission_mode: "default",
    });
    expect(deps.setSessionLifecycle).toHaveBeenCalledWith(
      SESSION_ID,
      "resuming"
    );
  });

  it("does not pass selected model id when resuming a Claude conversation", async () => {
    const deps = {
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(
      makeSession({
        providerResumeId: "conv-xyz",
        selectedModelId: "opus",
        selectedReasoningEffort: "high",
      }),
      SESSION_ID,
      deps
    );

    expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith({
      backend_session_id: expect.any(String),
      harness: "claude",
      working_dir: "/test/project",
      initial_prompt: null,
      provider_resume_id: "conv-xyz",
      model_id: null,
      reasoning_effort: null,
      permission_mode: "default",
    });
  });

  it("passes null workingDir when getCurrentProjectPath fails", async () => {
    mockedCommands.getCurrentProjectPath.mockResolvedValueOnce({
      status: "error",
      error: "no project",
    } as never);

    const deps = {
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(makeSession(), SESSION_ID, deps);

    expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith({
      backend_session_id: expect.any(String),
      harness: "claude",
      working_dir: null,
      initial_prompt: null,
      provider_resume_id: null,
      model_id: null,
      reasoning_effort: null,
      permission_mode: "default",
    });
  });

  it("passes the user message as the initial prompt without context", async () => {
    const deps = {
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(makeSession(), SESSION_ID, deps, "Question");

    expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith({
      backend_session_id: expect.any(String),
      harness: "claude",
      working_dir: "/test/project",
      initial_prompt: "Question",
      provider_resume_id: null,
      model_id: null,
      reasoning_effort: null,
      permission_mode: "default",
    });
  });

  it("sets error lifecycle and clears backend id when createLocalChatSession fails", async () => {
    mockedCommands.createLocalChatSession.mockResolvedValueOnce({
      status: "error",
      error: { SpawnFailed: "claude missing" },
    } as never);
    const deps = {
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
    };

    await doStartSession(makeSession(), SESSION_ID, deps);

    expect(deps.setBackendSessionId).toHaveBeenLastCalledWith(SESSION_ID, null);
    expect(deps.setBackendSessionIdRef).toHaveBeenLastCalledWith(null);
    expect(deps.addMessage).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        kind: "error",
        message: "claude missing",
      })
    );
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

  it("adds user message and calls sendLocalChatMessage", async () => {
    const deps = {
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
      markStreamingIfSending: vi.fn(),
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
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
    expect(mockedCommands.sendLocalChatMessage).toHaveBeenCalledWith(
      CLAUDE_SESSION_ID,
      "Hello"
    );
    expect(deps.markStreamingIfSending).toHaveBeenCalledWith(SESSION_ID);
    expect(deps.setSessionLifecycle).not.toHaveBeenCalledWith(
      SESSION_ID,
      "streaming"
    );
  });

  it("message includes a timestamp", async () => {
    const deps = {
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
      markStreamingIfSending: vi.fn(),
    };

    await doSendMessage(CLAUDE_SESSION_ID, SESSION_ID, "Hi", deps);

    expect(deps.addMessage.mock.calls[0][1].timestamp).toBeDefined();
  });

  it("sets error lifecycle when sendLocalChatMessage fails", async () => {
    mockedCommands.sendLocalChatMessage.mockResolvedValueOnce({
      status: "error",
      error: { SendFailed: "pipe closed" },
    } as never);
    const deps = {
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
      markStreamingIfSending: vi.fn(),
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
    };

    await doSendMessage(CLAUDE_SESSION_ID, SESSION_ID, "Hi", deps);

    expect(deps.setSessionLifecycle).toHaveBeenLastCalledWith(
      SESSION_ID,
      "error",
      "pipe closed"
    );
    expect(deps.markStreamingIfSending).not.toHaveBeenCalled();
  });

  it("clears stale backend id when sendLocalChatMessage reports not found", async () => {
    mockedCommands.sendLocalChatMessage.mockResolvedValueOnce({
      status: "error",
      error: { SessionNotFound: "missing" },
    } as never);
    const deps = {
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
      markStreamingIfSending: vi.fn(),
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
    };

    await doSendMessage(CLAUDE_SESSION_ID, SESSION_ID, "Hi", deps);

    expect(deps.setBackendSessionId).toHaveBeenCalledWith(SESSION_ID, null);
    expect(deps.setBackendSessionIdRef).toHaveBeenCalledWith(null);
    expect(deps.setSessionLifecycle).toHaveBeenLastCalledWith(
      SESSION_ID,
      "error",
      "missing"
    );
  });

  it("does not clear backend id for non-SessionNotFound errors containing not found", async () => {
    mockedCommands.sendLocalChatMessage.mockResolvedValueOnce({
      status: "error",
      error: { SendFailed: "File not found: /project/config.ts" },
    } as never);
    const deps = {
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
      markStreamingIfSending: vi.fn(),
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
    };

    await doSendMessage(CLAUDE_SESSION_ID, SESSION_ID, "Hi", deps);

    expect(deps.setBackendSessionId).not.toHaveBeenCalled();
    expect(deps.setBackendSessionIdRef).not.toHaveBeenCalled();
    expect(deps.setSessionLifecycle).toHaveBeenLastCalledWith(
      SESSION_ID,
      "error",
      "File not found: /project/config.ts"
    );
  });

  it("leaves lifecycle idle when End is processed before command resolve so queued follow-up can flush", async () => {
    localStorage.clear();
    useChatStore.setState({
      sessions: {},
      activeSessionId: null,
      paneLayout: { panes: [], activePaneId: null },
      panelOpen: false,
      localSessionSummaries: {},
    });
    const sessionId = useChatStore.getState().openSession("T1");
    useChatStore.getState().setBackendSessionId(sessionId, CLAUDE_SESSION_ID);
    const firstSend = deferredCommandResult();
    mockedCommands.sendLocalChatMessage
      .mockReturnValueOnce(firstSend.promise as never)
      .mockResolvedValueOnce({ status: "ok" } as never);

    const deps = {
      addMessage: useChatStore.getState().addMessage,
      setSessionLifecycle: useChatStore.getState().setSessionLifecycle,
      markStreamingIfSending: useChatStore.getState().markStreamingIfSending,
      setBackendSessionId: useChatStore.getState().setBackendSessionId,
    };
    const sendPromise = doSendMessage(
      CLAUDE_SESSION_ID,
      sessionId,
      "First",
      deps
    );

    expect(
      getLocalChatLifecycle(useChatStore.getState().sessions[sessionId])
    ).toBe("sending");

    handleEndEvent(
      {
        backend_session_id: CLAUDE_SESSION_ID,
        harness: "codex",
        duration_ms: 1000,
        cost_usd: 0,
        num_turns: 1,
        result: "done",
        is_error: false,
        context_tokens: 10,
        context_window: 200000,
      },
      CLAUDE_SESSION_ID,
      sessionId,
      useChatStore.getState().setSessionLifecycle,
      useChatStore.getState().clearStreamingAssistant,
      useChatStore.getState().setBackendSessionId,
      vi.fn()
    );
    expect(
      getLocalChatLifecycle(useChatStore.getState().sessions[sessionId])
    ).toBe("idle");

    firstSend.resolve({ status: "ok" });
    await sendPromise;
    expect(
      getLocalChatLifecycle(useChatStore.getState().sessions[sessionId])
    ).toBe("idle");

    const queuedMessages = ["Follow-up"];
    if (
      getLocalChatLifecycle(useChatStore.getState().sessions[sessionId]) ===
      "idle"
    ) {
      const content = queuedMessages.shift();
      if (content) {
        await doSendMessage(
          CLAUDE_SESSION_ID,
          sessionId,
          content,
          deps,
          { addUserMessage: false }
        );
      }
    }

    expect(queuedMessages).toEqual([]);
    expect(mockedCommands.sendLocalChatMessage).toHaveBeenNthCalledWith(
      2,
      CLAUDE_SESSION_ID,
      "Follow-up"
    );
  });
});

describe("doCloseSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls closeLocalChatSession and marks session closed", async () => {
    const deps = {
      markSessionClosed: vi.fn(),
      setSessionLifecycle: vi.fn(),
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
    };

    const closed = await doCloseSession(CLAUDE_SESSION_ID, SESSION_ID, deps);

    expect(mockedCommands.closeLocalChatSession).toHaveBeenCalledWith(
      CLAUDE_SESSION_ID
    );
    expect(closed).toBe(true);
    expect(deps.setSessionLifecycle).toHaveBeenCalledWith(
      SESSION_ID,
      "closing"
    );
    expect(deps.markSessionClosed).toHaveBeenCalledWith(SESSION_ID);
    expect(deps.setBackendSessionId).toHaveBeenCalledWith(SESSION_ID, null);
    expect(deps.setBackendSessionIdRef).toHaveBeenCalledWith(null);
  });

  it("does not call markSessionClosed when sessionId is null", async () => {
    const deps = {
      markSessionClosed: vi.fn(),
      setSessionLifecycle: vi.fn(),
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
    };

    const closed = await doCloseSession(CLAUDE_SESSION_ID, null, deps);

    expect(mockedCommands.closeLocalChatSession).toHaveBeenCalledWith(
      CLAUDE_SESSION_ID
    );
    expect(closed).toBe(true);
    expect(deps.markSessionClosed).not.toHaveBeenCalled();
  });

  it("treats missing backend session as already closed", async () => {
    mockedCommands.closeLocalChatSession.mockResolvedValueOnce({
      status: "error",
      error: { SessionNotFound: "missing" },
    } as never);
    const deps = {
      markSessionClosed: vi.fn(),
      setSessionLifecycle: vi.fn(),
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
    };

    const closed = await doCloseSession(CLAUDE_SESSION_ID, SESSION_ID, deps);

    expect(closed).toBe(true);
    expect(deps.markSessionClosed).toHaveBeenCalledWith(SESSION_ID);
    expect(deps.setBackendSessionId).toHaveBeenCalledWith(SESSION_ID, null);
    expect(deps.setBackendSessionIdRef).toHaveBeenCalledWith(null);
    expect(deps.setSessionLifecycle).not.toHaveBeenCalledWith(
      SESSION_ID,
      "error",
      "missing"
    );
  });

  it("sets error lifecycle when closeLocalChatSession fails for another reason", async () => {
    mockedCommands.closeLocalChatSession.mockResolvedValueOnce({
      status: "error",
      error: { SendFailed: "pipe closed" },
    } as never);
    const deps = {
      markSessionClosed: vi.fn(),
      setSessionLifecycle: vi.fn(),
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
    };

    const closed = await doCloseSession(CLAUDE_SESSION_ID, SESSION_ID, deps);

    expect(closed).toBe(false);
    expect(deps.markSessionClosed).not.toHaveBeenCalled();
    expect(deps.setBackendSessionId).not.toHaveBeenCalled();
    expect(deps.setBackendSessionIdRef).not.toHaveBeenCalled();
    expect(deps.setSessionLifecycle).toHaveBeenLastCalledWith(
      SESSION_ID,
      "error",
      "pipe closed"
    );
  });
});
