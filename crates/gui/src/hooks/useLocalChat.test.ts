import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleInitEvent,
  handleUsageEvent,
  handleTextEvent,
  handleToolCallEvent,
  handleToolResultEvent,
  handleFileChangeEvent,
  handleSacrumPermissionRequestEvent,
  handleEndEvent,
  handleErrorEvent,
  handleWarningEvent,
  doStartSession,
  doRegenerateSessionTitle,
  titleInferenceTranscript,
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
        thread_total_tokens: 979_558,
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
      },
      979_558
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
        thread_total_tokens: 75_000,
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      setUsage
    );
    expect(setUsage).toHaveBeenCalledWith(
      SESSION_ID,
      "claude-mystery-9-9",
      {
        used: 50_000,
        max: 250_000,
      },
      75_000
    );
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
        thread_total_tokens: 1,
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

describe("handleFileChangeEvent", () => {
  it("normalizes Claude and Codex file changes into one chat message shape", () => {
    const addMsg = vi.fn();
    handleFileChangeEvent(
      {
        backend_session_id: CLAUDE_SESSION_ID,
        harness: "codex",
        tool_id: "file-1",
        status: "completed",
        changes: [{ path: "src/new.ts", kind: "add", diff: "+export {}" }],
        parent_tool_use_id: "parent-1",
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      addMsg
    );
    expect(addMsg).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        kind: "file_edit",
        toolId: "file-1",
        status: "completed",
        changes: [{ path: "src/new.ts", kind: "add", diff: "+export {}" }],
        parentToolUseId: "parent-1",
      })
    );
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

  it("creates a structured user question instead of a generic permission", () => {
    const addMsg = vi.fn();
    const questions = [
      {
        question: "Pick one",
        header: "Choice",
        options: [{ label: "A", description: "First" }],
        multi_select: false,
      },
    ];
    handleSacrumPermissionRequestEvent(
      {
        request_id: "request-ask",
        session_id: CLAUDE_SESSION_ID,
        tool_name: "AskUserQuestion",
        tool_use_id: "tool-ask",
        input: { questions },
        message: null,
        questions,
        input_error: null,
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      addMsg
    );
    expect(addMsg).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        kind: "user_question",
        requestId: "request-ask",
        toolUseId: "tool-ask",
        questions,
        originalQuestions: questions,
        status: "pending",
      })
    );
  });
});

describe("handleEndEvent", () => {
  it("clears stream state and returns lifecycle to idle when session matches", () => {
    const setLifecycle = vi.fn();
    const clearStreaming = vi.fn();
    handleEndEvent(
      {
        backend_session_id: CLAUDE_SESSION_ID,
        harness: "claude",
        turn_id: "turn-1",
        is_root: true,
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
      clearStreaming
    );
    expect(clearStreaming).toHaveBeenCalledWith(SESSION_ID, true);
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
        thread_total_tokens: 150_000,
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
        turn_id: "turn-1",
        is_root: true,
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
      vi.fn()
    );

    expect(setUsage).toHaveBeenCalledOnce();
    expect(tokenUsage).toEqual({ used: 100_050, max: 200_000 });
    expect(setLifecycle).toHaveBeenCalledWith(SESSION_ID, "idle");
  });

  it("sets error lifecycle when Claude reports an error result", () => {
    const setLifecycle = vi.fn();
    const clearStreaming = vi.fn();
    handleEndEvent(
      {
        backend_session_id: CLAUDE_SESSION_ID,
        harness: "claude",
        turn_id: "turn-1",
        is_root: true,
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
      clearStreaming
    );
    expect(clearStreaming).toHaveBeenCalledWith(SESSION_ID, true);
    expect(setLifecycle).toHaveBeenCalledWith(
      SESSION_ID,
      "error",
      "tool failed"
    );
  });

  it("commits the streaming tail exactly once when the session ends", () => {
    useChatStore.getState().reset();
    const id = useChatStore.getState().openSession("End cleanup");
    useChatStore.getState().updateLastAssistantMessage(id, "Partial");
    useChatStore.getState().updateLastAssistantMessage(id, "Partial answer");

    handleEndEvent(
      {
        backend_session_id: CLAUDE_SESSION_ID,
        harness: "claude",
        turn_id: "turn-1",
        is_root: true,
        duration_ms: 1000,
        cost_usd: 0.01,
        num_turns: 1,
        result: "Partial answer",
        is_error: false,
        context_tokens: 1000,
        context_window: 200000,
      },
      CLAUDE_SESSION_ID,
      id,
      useChatStore.getState().setSessionLifecycle,
      useChatStore.getState().clearStreamingAssistant
    );
    handleEndEvent(
      {
        backend_session_id: CLAUDE_SESSION_ID,
        harness: "claude",
        turn_id: "turn-1",
        is_root: true,
        duration_ms: 1000,
        cost_usd: 0.01,
        num_turns: 1,
        result: "Partial answer",
        is_error: false,
        context_tokens: 1000,
        context_window: 200000,
      },
      CLAUDE_SESSION_ID,
      id,
      useChatStore.getState().setSessionLifecycle,
      useChatStore.getState().clearStreamingAssistant
    );

    expect(useChatStore.getState().sessions[id]).toMatchObject({
      lifecycle: "idle",
      streamingAssistant: null,
      messages: [
        {
          kind: "assistant",
          text: "Partial answer",
          isPartial: false,
        },
      ],
    });
  });

  it("keeps the live Claude backend id across a per-turn End", () => {
    const setLifecycle = vi.fn();
    const clearStreaming = vi.fn();

    handleEndEvent(
      {
        backend_session_id: CLAUDE_SESSION_ID,
        harness: "claude",
        turn_id: "turn-1",
        is_root: true,
        duration_ms: 1000,
        cost_usd: 0.01,
        num_turns: 1,
        result: "agent launched and running",
        is_error: false,
        context_tokens: 0,
        context_window: 200000,
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      setLifecycle,
      clearStreaming
    );

    expect(clearStreaming).toHaveBeenCalledWith(SESSION_ID, true);
    expect(setLifecycle).toHaveBeenCalledWith(SESSION_ID, "idle");
  });

  it("does nothing when session does not match", () => {
    const setLifecycle = vi.fn();
    const clearStreaming = vi.fn();
    handleEndEvent(
      {
        backend_session_id: OTHER_SESSION_ID,
        harness: "claude",
        turn_id: "turn-1",
        is_root: true,
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
      clearStreaming
    );
    expect(setLifecycle).not.toHaveBeenCalled();
    expect(clearStreaming).not.toHaveBeenCalled();
  });
});

describe("handleErrorEvent", () => {
  it("clears the dead backend id and adds an error message when session matches", () => {
    const addMsg = vi.fn();
    const setLifecycle = vi.fn();
    const clearStreaming = vi.fn();
    const setBackendSessionId = vi.fn();
    const setBackendSessionIdRef = vi.fn();
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
    const setBackendSessionId = vi.fn();
    const setBackendSessionIdRef = vi.fn();
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
      clearStreaming,
      setBackendSessionId,
      setBackendSessionIdRef
    );
    expect(addMsg).not.toHaveBeenCalled();
    expect(setLifecycle).not.toHaveBeenCalled();
    expect(clearStreaming).not.toHaveBeenCalled();
    expect(setBackendSessionId).not.toHaveBeenCalled();
    expect(setBackendSessionIdRef).not.toHaveBeenCalled();
  });

  it("commits and removes the streaming tail before rendering an error", () => {
    useChatStore.getState().reset();
    const id = useChatStore.getState().openSession("Error cleanup");
    useChatStore.getState().setBackendSessionId(id, CLAUDE_SESSION_ID);
    useChatStore.getState().updateLastAssistantMessage(id, "Interrupted reply");

    handleErrorEvent(
      {
        backend_session_id: CLAUDE_SESSION_ID,
        harness: "claude",
        error: "provider failed",
      },
      CLAUDE_SESSION_ID,
      id,
      useChatStore.getState().addMessage,
      useChatStore.getState().setSessionLifecycle,
      useChatStore.getState().clearStreamingAssistant,
      useChatStore.getState().setBackendSessionId
    );

    const session = useChatStore.getState().sessions[id];
    expect(session.streamingAssistant).toBeNull();
    expect(session.backendSessionId).toBeNull();
    expect(session.lifecycle).toBe("error");
    expect(session.lifecycleError).toBe("provider failed");
    expect(session.messages).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "Interrupted reply",
        isPartial: false,
      }),
      expect.objectContaining({ kind: "error", message: "provider failed" }),
    ]);
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

  it.each(["claude", "codex"] as const)(
    "passes the selected project path to %s startup without consulting the global project",
    async (harness) => {
      const deps = {
        setBackendSessionId: vi.fn(),
        setBackendSessionIdRef: vi.fn(),
        setContextSummary: vi.fn(),
        addMessage: vi.fn(),
        setSessionLifecycle: vi.fn(),
      };

      await doStartSession(
        makeSession({
          harness,
          projectPath: "/selected/project",
        }),
        SESSION_ID,
        deps
      );

      expect(mockedCommands.getCurrentProjectPath).not.toHaveBeenCalled();
      expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith(
        expect.objectContaining({
          harness,
          working_dir: "/selected/project",
        })
      );
    }
  );

  it.each(["claude", "codex"] as const)(
    "reports a selected %s directory startup failure without falling back",
    async (harness) => {
      mockedCommands.createLocalChatSession.mockResolvedValueOnce({
        status: "error",
        error: { StartFailed: "selected directory is unavailable" },
      } as never);
      const deps = {
        setBackendSessionId: vi.fn(),
        setBackendSessionIdRef: vi.fn(),
        setContextSummary: vi.fn(),
        addMessage: vi.fn(),
        setSessionLifecycle: vi.fn(),
      };

      await doStartSession(
        makeSession({
          harness,
          projectPath: "/missing/selected/project",
        }),
        SESSION_ID,
        deps
      );

      expect(mockedCommands.getCurrentProjectPath).not.toHaveBeenCalled();
      expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith(
        expect.objectContaining({
          harness,
          working_dir: "/missing/selected/project",
        })
      );
      expect(deps.setSessionLifecycle).toHaveBeenLastCalledWith(
        SESSION_ID,
        "error",
        "selected directory is unavailable"
      );
    }
  );

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

  it("passes the selected speed tier to the neutral create command", async () => {
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
        selectedSpeedTier: "fast",
      }),
      SESSION_ID,
      deps
    );

    expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith(
      expect.objectContaining({
        harness: "codex",
        model_id: "gpt-5.5",
        speed_tier: "fast",
      })
    );
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
      expect(deps.setSessionTitleCandidate).toHaveBeenCalledWith(SESSION_ID, {
        title: "Inferred Title",
        confidence: 0.91,
        sufficientSignal: true,
        userMessageCount: 1,
      })
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

    await doStartSession(
      makeSession({ label: "Task Chat" }),
      SESSION_ID,
      deps,
      "Help"
    );

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

  it("begins and settles a turn only for a prompted start", async () => {
    const withPrompt = {
      setBackendSessionId: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
      beginActiveTurn: vi.fn(() => "local-turn-1"),
      settleActiveTurn: vi.fn(),
    };
    await doStartSession(makeSession(), SESSION_ID, withPrompt, "hello");
    expect(withPrompt.beginActiveTurn).toHaveBeenCalledWith(SESSION_ID);
    expect(withPrompt.settleActiveTurn).not.toHaveBeenCalled();
    expect(withPrompt.setSessionLifecycle).toHaveBeenLastCalledWith(
      SESSION_ID,
      "streaming"
    );

    const withoutPrompt = {
      setBackendSessionId: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
      beginActiveTurn: vi.fn(() => "local-turn-2"),
      settleActiveTurn: vi.fn(),
    };
    await doStartSession(makeSession(), SESSION_ID, withoutPrompt);
    expect(withoutPrompt.beginActiveTurn).not.toHaveBeenCalled();
    expect(withoutPrompt.setSessionLifecycle).toHaveBeenLastCalledWith(
      SESSION_ID,
      "idle"
    );
  });

  it("settles the started turn when createLocalChatSession fails", async () => {
    mockedCommands.createLocalChatSession.mockResolvedValueOnce({
      status: "error",
      error: { SpawnFailed: "claude missing" },
    } as never);
    const deps = {
      setBackendSessionId: vi.fn(),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
      beginActiveTurn: vi.fn(() => "local-turn-1"),
      settleActiveTurn: vi.fn(),
      getActiveTurnLocalId: vi.fn(() => "local-turn-1"),
      getBackendSessionId: vi.fn(
        () => deps.setBackendSessionId.mock.calls[0]?.[1] ?? null
      ),
    };

    await doStartSession(makeSession(), SESSION_ID, deps, "hello");

    expect(deps.settleActiveTurn).toHaveBeenCalledWith(SESSION_ID);
    expect(deps.setSessionLifecycle).toHaveBeenLastCalledWith(
      SESSION_ID,
      "error",
      "claude missing"
    );
  });

  it("does not resurrect a lifecycle when a stop lands before the start resolves", async () => {
    const create = deferredCommandResult();
    mockedCommands.createLocalChatSession.mockReturnValueOnce(
      create.promise as never
    );
    // The stop nulls the backend id and settles the turn while the create is
    // still in flight; the late success must not write anything back.
    let backendSessionId: string | null = null;
    let activeTurnLocalId: string | null = "local-turn-1";
    const deps = {
      setBackendSessionId: vi.fn((_id: string, backendId: string | null) => {
        backendSessionId = backendId;
      }),
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
      beginActiveTurn: vi.fn(() => "local-turn-1"),
      settleActiveTurn: vi.fn(),
      getActiveTurnLocalId: vi.fn(() => activeTurnLocalId),
      getBackendSessionId: vi.fn(() => backendSessionId),
    };

    const starting = doStartSession(makeSession(), SESSION_ID, deps, "hello");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    backendSessionId = null;
    activeTurnLocalId = null;
    deps.setSessionLifecycle.mockClear();
    create.resolve({ status: "ok" });
    await starting;

    expect(deps.setSessionLifecycle).not.toHaveBeenCalled();
  });
});

describe("doRegenerateSessionTitle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["claude", "codex"] as const)(
    "passes the full active transcript through the neutral command for %s",
    async (harness) => {
      const session = makeSession({
        harness,
        projectPath: "/captured/project",
        messages: [
          {
            kind: "user",
            text: "Inspect the title flow",
            timestamp: "2026-01-01T00:00:00Z",
          },
          {
            kind: "assistant",
            text: "I will inspect the shared title path.",
            timestamp: "2026-01-01T00:00:01Z",
          },
          {
            kind: "user",
            text: "Also cover reload persistence",
            timestamp: "2026-01-01T00:00:02Z",
          },
          {
            kind: "assistant",
            text: "The title should survive reopening.",
            timestamp: "2026-01-01T00:00:03Z",
          },
          {
            kind: "assistant",
            text: "partial response",
            timestamp: "2026-01-01T00:00:04Z",
            isPartial: true,
          },
        ],
      });
      const setSessionTitleCandidate = vi.fn();

      const error = await doRegenerateSessionTitle(
        session,
        SESSION_ID,
        setSessionTitleCandidate
      );

      expect(error).toBeNull();
      expect(mockedCommands.inferLocalChatSessionTitle).toHaveBeenCalledWith({
        harness,
        initial_prompts: [
          "User: Inspect the title flow",
          "Assistant: I will inspect the shared title path.",
          "User: Also cover reload persistence",
          "Assistant: The title should survive reopening.",
          "Assistant (partial): partial response",
        ],
        working_dir: "/captured/project",
      });
      expect(setSessionTitleCandidate).toHaveBeenCalledWith(
        SESSION_ID,
        {
          title: "Inferred Title",
          confidence: 0.91,
          sufficientSignal: true,
          userMessageCount: 2,
        },
        {
          replaceGenerated: true,
          expectedMessageCount: session.messages.length,
        }
      );
    }
  );

  it("keeps the current title untouched when the neutral command fails", async () => {
    mockedCommands.inferLocalChatSessionTitle.mockResolvedValueOnce({
      status: "error",
      error: { message: "provider unavailable" },
    });
    const setSessionTitleCandidate = vi.fn();

    const error = await doRegenerateSessionTitle(
      makeSession({
        title: "Existing title",
        titleStatus: "generated",
        messages: [
          {
            kind: "user",
            text: "Continue the existing chat",
            timestamp: "2026-01-01T00:00:00Z",
          },
        ],
      }),
      SESSION_ID,
      setSessionTitleCandidate
    );

    expect(error).toBe("provider unavailable");
    expect(setSessionTitleCandidate).not.toHaveBeenCalled();
  });

  it("does not regenerate a manual title", async () => {
    const error = await doRegenerateSessionTitle(
      makeSession({ title: "Manual title", titleStatus: "manual" }),
      SESSION_ID,
      vi.fn()
    );

    expect(error).toBeNull();
    expect(mockedCommands.inferLocalChatSessionTitle).not.toHaveBeenCalled();
  });

  it("reports an empty transcript without invoking inference", async () => {
    const error = await doRegenerateSessionTitle(
      makeSession(),
      SESSION_ID,
      vi.fn()
    );

    expect(error).toBe("Add a message before regenerating the chat title.");
    expect(mockedCommands.inferLocalChatSessionTitle).not.toHaveBeenCalled();
  });

  it("formats every active transcript record for neutral inference", () => {
    expect(
      titleInferenceTranscript([
        {
          kind: "user",
          text: "A request",
          timestamp: "2026-01-01T00:00:00Z",
        },
        {
          kind: "tool_call",
          toolName: "Read",
          toolId: "tool-1",
          input: '{"path":"src/title.ts"}',
          timestamp: "2026-01-01T00:00:01Z",
        },
        {
          kind: "tool_result",
          toolId: "tool-1",
          result: "file contents",
          isError: false,
          timestamp: "2026-01-01T00:00:01Z",
        },
        {
          kind: "assistant",
          text: "A response",
          timestamp: "2026-01-01T00:00:02Z",
          isPartial: true,
        },
      ])
    ).toEqual({
      entries: [
        "User: A request",
        'Tool call (Read): {"path":"src/title.ts"}',
        "Tool result: file contents",
        "Assistant (partial): A response",
      ],
      userMessageCount: 1,
    });
  });

  it("passes an exact-threshold candidate to the shared title policy", async () => {
    mockedCommands.inferLocalChatSessionTitle.mockResolvedValueOnce({
      status: "ok",
      data: {
        title: "Exact Threshold Title",
        confidence: 0.72,
        sufficient_signal: true,
      },
    });
    const setSessionTitleCandidate = vi.fn();

    await expect(
      doRegenerateSessionTitle(
        makeSession({
          messages: [
            {
              kind: "user",
              text: "Use the exact threshold",
              timestamp: "2026-01-01T00:00:00Z",
            },
          ],
        }),
        SESSION_ID,
        setSessionTitleCandidate
      )
    ).resolves.toBeNull();

    expect(setSessionTitleCandidate.mock.calls[0]?.[1]).toMatchObject({
      title: "Exact Threshold Title",
      confidence: 0.72,
      sufficientSignal: true,
    });
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
      settleActiveTurn: vi.fn(),
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
      settleActiveTurn: vi.fn(),
    };

    await doSendMessage(CLAUDE_SESSION_ID, SESSION_ID, "Hi", deps);

    expect(deps.setBackendSessionId).toHaveBeenCalledWith(SESSION_ID, null);
    expect(deps.setBackendSessionIdRef).toHaveBeenCalledWith(null);
    expect(deps.settleActiveTurn).toHaveBeenCalledWith(SESSION_ID);
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
      settleActiveTurn: vi.fn(),
    };

    await doSendMessage(CLAUDE_SESSION_ID, SESSION_ID, "Hi", deps);

    expect(deps.setBackendSessionId).not.toHaveBeenCalled();
    expect(deps.setBackendSessionIdRef).not.toHaveBeenCalled();
    expect(deps.settleActiveTurn).toHaveBeenCalledWith(SESSION_ID);
    expect(deps.setSessionLifecycle).toHaveBeenLastCalledWith(
      SESSION_ID,
      "error",
      "File not found: /project/config.ts"
    );
  });

  it("keeps Claude backend id when End is processed before command resolve so queued follow-up uses live stdin", async () => {
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
        harness: "claude",
        turn_id: "turn-1",
        is_root: true,
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
      useChatStore.getState().clearStreamingAssistant
    );
    expect(
      getLocalChatLifecycle(useChatStore.getState().sessions[sessionId])
    ).toBe("idle");
    expect(useChatStore.getState().sessions[sessionId].backendSessionId).toBe(
      CLAUDE_SESSION_ID
    );

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
        await doSendMessage(CLAUDE_SESSION_ID, sessionId, content, deps, {
          addUserMessage: false,
        });
      }
    }

    expect(queuedMessages).toEqual([]);
    expect(mockedCommands.sendLocalChatMessage).toHaveBeenNthCalledWith(
      2,
      CLAUDE_SESSION_ID,
      "Follow-up"
    );
  });

  it("resumes with provider resume id on the first send after a terminal Error clears the dead backend", async () => {
    localStorage.clear();
    useChatStore.setState({
      sessions: {},
      activeSessionId: null,
      paneLayout: { panes: [], activePaneId: null },
      panelOpen: false,
      localSessionSummaries: {},
    });
    const sessionId = useChatStore.getState().openSession("T1", "/repo/root");
    useChatStore.getState().setBackendSessionId(sessionId, CLAUDE_SESSION_ID);
    useChatStore.getState().setProviderResumeId(sessionId, "claude-conv-1");

    handleErrorEvent(
      {
        backend_session_id: CLAUDE_SESSION_ID,
        harness: "claude",
        error: "Claude session ended unexpectedly: stdout closed",
      },
      CLAUDE_SESSION_ID,
      sessionId,
      useChatStore.getState().addMessage,
      useChatStore.getState().setSessionLifecycle,
      useChatStore.getState().clearStreamingAssistant,
      useChatStore.getState().setBackendSessionId,
      vi.fn()
    );

    const erroredSession = useChatStore.getState().sessions[sessionId];
    expect(erroredSession.backendSessionId).toBeNull();
    expect(erroredSession.providerResumeId).toBe("claude-conv-1");
    expect(getLocalChatLifecycle(erroredSession)).toBe("error");

    await doStartSession(
      useChatStore.getState().sessions[sessionId],
      sessionId,
      {
        setBackendSessionId: useChatStore.getState().setBackendSessionId,
        setBackendSessionIdRef: vi.fn(),
        addMessage: useChatStore.getState().addMessage,
        setSessionLifecycle: useChatStore.getState().setSessionLifecycle,
      },
      "Retry after crash"
    );

    expect(mockedCommands.sendLocalChatMessage).not.toHaveBeenCalled();
    expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith({
      backend_session_id: expect.stringMatching(/^local-/),
      harness: "claude",
      working_dir: "/repo/root",
      initial_prompt: "Retry after crash",
      provider_resume_id: "claude-conv-1",
      model_id: null,
      reasoning_effort: null,
      permission_mode: "default",
    });
  });

  it("does not settle a replacement turn when an abandoned send fails late", async () => {
    const firstSend = deferredCommandResult();
    mockedCommands.sendLocalChatMessage.mockReturnValueOnce(
      firstSend.promise as never
    );
    let activeTurnLocalId: string | null = "local-turn-1";
    let backendSessionId: string | null = CLAUDE_SESSION_ID;
    const deps = {
      addMessage: vi.fn(),
      setSessionLifecycle: vi.fn(),
      markStreamingIfSending: vi.fn(),
      beginActiveTurn: vi.fn(() => activeTurnLocalId),
      settleActiveTurn: vi.fn(),
      setBackendSessionId: vi.fn(),
      getActiveTurnLocalId: vi.fn(() => activeTurnLocalId),
      getBackendSessionId: vi.fn(() => backendSessionId),
    };

    const sending = doSendMessage(CLAUDE_SESSION_ID, SESSION_ID, "hi", deps);

    // Stop tears the first turn down, then the user starts a fresh one.
    activeTurnLocalId = "local-turn-2";
    backendSessionId = "replacement-backend";
    deps.setSessionLifecycle.mockClear();
    firstSend.resolve({ status: "error" } as never);
    await sending;

    expect(deps.settleActiveTurn).not.toHaveBeenCalled();
    expect(deps.setSessionLifecycle).not.toHaveBeenCalled();
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
      clearStreamingAssistant: vi.fn(),
      settleActiveTurn: vi.fn(),
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
    expect(deps.clearStreamingAssistant).toHaveBeenCalledWith(SESSION_ID, true);
    expect(deps.setBackendSessionId).toHaveBeenCalledWith(SESSION_ID, null);
    expect(deps.setBackendSessionIdRef).toHaveBeenCalledWith(null);
    expect(deps.settleActiveTurn).toHaveBeenCalledWith(SESSION_ID);
  });

  it("commits and removes the streaming tail after a successful stop", async () => {
    useChatStore.getState().reset();
    const id = useChatStore.getState().openSession("Stop cleanup");
    useChatStore.getState().setBackendSessionId(id, CLAUDE_SESSION_ID);
    useChatStore.getState().updateLastAssistantMessage(id, "Stopped reply");

    const closed = await doCloseSession(CLAUDE_SESSION_ID, id, {
      markSessionClosed: (sessionId) =>
        useChatStore.getState().setSessionLifecycle(sessionId, "idle"),
      setSessionLifecycle: useChatStore.getState().setSessionLifecycle,
      setBackendSessionId: useChatStore.getState().setBackendSessionId,
      clearStreamingAssistant: useChatStore.getState().clearStreamingAssistant,
    });

    expect(closed).toBe(true);
    expect(useChatStore.getState().sessions[id]).toMatchObject({
      backendSessionId: null,
      lifecycle: "idle",
      streamingAssistant: null,
      messages: [
        {
          kind: "assistant",
          text: "Stopped reply",
          isPartial: false,
        },
      ],
    });
  });

  it("does not call markSessionClosed when sessionId is null", async () => {
    const deps = {
      markSessionClosed: vi.fn(),
      setSessionLifecycle: vi.fn(),
      setBackendSessionId: vi.fn(),
      setBackendSessionIdRef: vi.fn(),
      settleActiveTurn: vi.fn(),
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
      settleActiveTurn: vi.fn(),
    };

    const closed = await doCloseSession(CLAUDE_SESSION_ID, SESSION_ID, deps);

    expect(closed).toBe(false);
    expect(deps.markSessionClosed).not.toHaveBeenCalled();
    expect(deps.setBackendSessionId).not.toHaveBeenCalled();
    expect(deps.setBackendSessionIdRef).not.toHaveBeenCalled();
    expect(deps.settleActiveTurn).not.toHaveBeenCalled();
    expect(deps.setSessionLifecycle).toHaveBeenLastCalledWith(
      SESSION_ID,
      "error",
      "pipe closed"
    );
  });

  it("restores a stopping turn when close transport fails", async () => {
    mockedCommands.closeLocalChatSession.mockResolvedValueOnce({
      status: "error",
      error: { SendFailed: "transport unavailable" },
    } as never);
    const deps = {
      markSessionClosed: vi.fn(),
      setSessionLifecycle: vi.fn(),
      setBackendSessionId: vi.fn(),
      settleActiveTurn: vi.fn(),
      getActiveTurnLocalId: vi.fn(() => "local-turn-1"),
      restoreActiveTurn: vi.fn(() => true),
    };

    const closed = await doCloseSession(CLAUDE_SESSION_ID, SESSION_ID, deps, {
      expectedActiveTurnLocalId: "local-turn-1",
      failureLifecycle: "streaming",
    });

    expect(closed).toBe(false);
    expect(deps.restoreActiveTurn).toHaveBeenCalledWith(
      SESSION_ID,
      "local-turn-1"
    );
    expect(deps.settleActiveTurn).not.toHaveBeenCalled();
    expect(deps.setBackendSessionId).not.toHaveBeenCalled();
    expect(deps.setSessionLifecycle).toHaveBeenLastCalledWith(
      SESSION_ID,
      "streaming"
    );
  });

  it("leaves a terminal stopping turn idle when close transport fails", async () => {
    mockedCommands.closeLocalChatSession.mockResolvedValueOnce({
      status: "error",
      error: { SendFailed: "transport unavailable" },
    } as never);
    const deps = {
      markSessionClosed: vi.fn(),
      setSessionLifecycle: vi.fn(),
      setBackendSessionId: vi.fn(),
      getActiveTurnLocalId: vi.fn(() => null),
      getBackendSessionId: vi.fn(() => CLAUDE_SESSION_ID),
      restoreActiveTurn: vi.fn(),
    };

    expect(
      await doCloseSession(CLAUDE_SESSION_ID, SESSION_ID, deps, {
        expectedActiveTurnLocalId: "settled-local-turn",
        failureLifecycle: "streaming",
      })
    ).toBe(false);

    expect(deps.restoreActiveTurn).not.toHaveBeenCalled();
    expect(deps.setBackendSessionId).not.toHaveBeenCalled();
    expect(deps.setSessionLifecycle).toHaveBeenNthCalledWith(
      1,
      SESSION_ID,
      "closing"
    );
    expect(deps.setSessionLifecycle).toHaveBeenNthCalledWith(
      2,
      SESSION_ID,
      "idle"
    );
  });

  it("does not clear a settled replacement backend when an earlier close resolves", async () => {
    const close = deferredCommandResult();
    mockedCommands.closeLocalChatSession.mockReturnValueOnce(
      close.promise as never
    );
    let currentLocalId: string | null = "local-turn-1";
    let currentBackendSessionId = CLAUDE_SESSION_ID;
    const deps = {
      markSessionClosed: vi.fn(),
      setSessionLifecycle: vi.fn(),
      setBackendSessionId: vi.fn(),
      clearQueuedMessages: vi.fn(),
      settleActiveTurn: vi.fn(),
      getActiveTurnLocalId: vi.fn(() => currentLocalId),
      getBackendSessionId: vi.fn(() => currentBackendSessionId),
    };
    const closing = doCloseSession(CLAUDE_SESSION_ID, SESSION_ID, deps, {
      expectedActiveTurnLocalId: "local-turn-1",
    });

    currentLocalId = null;
    currentBackendSessionId = "replacement-backend";
    close.resolve({ status: "ok" });

    expect(await closing).toBe(true);
    expect(deps.markSessionClosed).not.toHaveBeenCalled();
    expect(deps.setBackendSessionId).not.toHaveBeenCalled();
    expect(deps.clearQueuedMessages).not.toHaveBeenCalled();
    expect(deps.settleActiveTurn).not.toHaveBeenCalled();
  });
});
