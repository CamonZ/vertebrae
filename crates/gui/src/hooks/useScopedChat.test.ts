import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleInitEvent,
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
    getCurrentProject: vi.fn().mockResolvedValue({
      status: "ok",
      data: "test-project",
    }),
    getTask: vi.fn().mockResolvedValue({ status: "error", error: "unused" }),
    getTaskExecutions: vi
      .fn()
      .mockResolvedValue({ status: "ok", data: [] }),
    getWorkflowWithTasks: vi
      .fn()
      .mockResolvedValue({ status: "error", error: "unused" }),
    getStep: vi
      .fn()
      .mockResolvedValue({ status: "error", error: "unused" }),
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
  it("calls setClaudeConversationId when session matches and conversation ID present", () => {
    const setConvId = vi.fn();
    handleInitEvent(
      {
        session_id: CLAUDE_SESSION_ID,
        claude_conversation_id: "conv-abc",
        model: "claude-sonnet-4",
        tools: [],
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      setConvId
    );
    expect(setConvId).toHaveBeenCalledWith(SESSION_ID, "conv-abc");
  });

  it("does not call setClaudeConversationId when session ID does not match", () => {
    const setConvId = vi.fn();
    handleInitEvent(
      {
        session_id: OTHER_SESSION_ID,
        claude_conversation_id: "conv-abc",
        model: "claude-sonnet-4",
        tools: [],
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      setConvId
    );
    expect(setConvId).not.toHaveBeenCalled();
  });

  it("does not call setClaudeConversationId when conversation ID is null", () => {
    const setConvId = vi.fn();
    handleInitEvent(
      {
        session_id: CLAUDE_SESSION_ID,
        claude_conversation_id: null,
        model: "claude-sonnet-4",
        tools: [],
      },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      setConvId
    );
    expect(setConvId).not.toHaveBeenCalled();
  });
});

describe("handleTextEvent", () => {
  it("calls updateLastAssistantMessage for partial text", () => {
    const update = vi.fn();
    const finalize = vi.fn();
    handleTextEvent(
      { session_id: CLAUDE_SESSION_ID, text: "hello", is_partial: true },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      update,
      finalize
    );
    expect(update).toHaveBeenCalledWith(SESSION_ID, "hello");
    expect(finalize).not.toHaveBeenCalled();
  });

  it("calls finalizeLastAssistantMessage for complete text", () => {
    const update = vi.fn();
    const finalize = vi.fn();
    handleTextEvent(
      { session_id: CLAUDE_SESSION_ID, text: "done", is_partial: false },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      update,
      finalize
    );
    expect(finalize).toHaveBeenCalledWith(SESSION_ID, "done");
    expect(update).not.toHaveBeenCalled();
  });

  it("does nothing when session ID does not match", () => {
    const update = vi.fn();
    const finalize = vi.fn();
    handleTextEvent(
      { session_id: OTHER_SESSION_ID, text: "hello", is_partial: true },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      update,
      finalize
    );
    expect(update).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
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
  it("calls markSessionClosed when session matches", () => {
    const close = vi.fn();
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
      close
    );
    expect(close).toHaveBeenCalledWith(SESSION_ID);
  });

  it("does nothing when session does not match", () => {
    const close = vi.fn();
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
      close
    );
    expect(close).not.toHaveBeenCalled();
  });
});

describe("handleErrorEvent", () => {
  it("adds an error message when session matches", () => {
    const addMsg = vi.fn();
    handleErrorEvent(
      { session_id: CLAUDE_SESSION_ID, error: "something broke" },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      addMsg
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
    handleErrorEvent(
      { session_id: OTHER_SESSION_ID, error: "x" },
      CLAUDE_SESSION_ID,
      SESSION_ID,
      addMsg
    );
    expect(addMsg).not.toHaveBeenCalled();
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
    };

    await doStartSession(makeSession(), SESSION_ID, deps);

    expect(deps.setClaudeSessionId).toHaveBeenCalledWith(
      SESSION_ID,
      expect.stringMatching(/^scoped-session-1-\d+$/)
    );
    expect(deps.setClaudeSessionIdRef).toHaveBeenCalledWith(
      expect.stringMatching(/^scoped-session-1-\d+$/)
    );
  });

  it("calls createClaudeSession with working directory", async () => {
    const deps = {
      setClaudeSessionId: vi.fn(),
      setClaudeSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
    };

    await doStartSession(makeSession(), SESSION_ID, deps);

    expect(mockedCommands.createClaudeSession).toHaveBeenCalledWith(
      expect.stringMatching(/^scoped-/),
      "/test/project",
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
    };

    await doStartSession(makeSession(), SESSION_ID, deps, "Hello");

    expect(deps.addMessage).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        kind: "user",
        text: "Hello",
      })
    );
  });

  it("does not add user message when not provided", async () => {
    const deps = {
      setClaudeSessionId: vi.fn(),
      setClaudeSessionIdRef: vi.fn(),
      setContextSummary: vi.fn(),
      addMessage: vi.fn(),
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
});

describe("doSendMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds user message and calls sendClaudeMessage", async () => {
    const addMsg = vi.fn();

    await doSendMessage(CLAUDE_SESSION_ID, SESSION_ID, "Hello", addMsg);

    expect(addMsg).toHaveBeenCalledWith(
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
  });

  it("message includes a timestamp", async () => {
    const addMsg = vi.fn();

    await doSendMessage(CLAUDE_SESSION_ID, SESSION_ID, "Hi", addMsg);

    expect(addMsg.mock.calls[0][1].timestamp).toBeDefined();
  });
});

describe("doCloseSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls closeClaudeSession and marks session closed", async () => {
    const markClosed = vi.fn();

    await doCloseSession(CLAUDE_SESSION_ID, SESSION_ID, markClosed);

    expect(mockedCommands.closeClaudeSession).toHaveBeenCalledWith(
      CLAUDE_SESSION_ID
    );
    expect(markClosed).toHaveBeenCalledWith(SESSION_ID);
  });

  it("does not call markSessionClosed when sessionId is null", async () => {
    const markClosed = vi.fn();

    await doCloseSession(CLAUDE_SESSION_ID, null, markClosed);

    expect(mockedCommands.closeClaudeSession).toHaveBeenCalledWith(
      CLAUDE_SESSION_ID
    );
    expect(markClosed).not.toHaveBeenCalled();
  });
});
