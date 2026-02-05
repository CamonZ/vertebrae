import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Use vi.hoisted to allow access to mocks in the mock factory
const { mockCommands, mockEvents, eventListeners, emitEvent } = vi.hoisted(
  () => {
    type EventCallback = (event: {
      payload: Record<string, unknown>;
    }) => void;
    const listeners: Record<string, EventCallback[]> = {};

    function createEventListener(eventName: string) {
      return {
        listen: vi.fn((callback: EventCallback) => {
          listeners[eventName] = listeners[eventName] || [];
          listeners[eventName].push(callback);
          return Promise.resolve(() => {
            const idx = listeners[eventName].indexOf(callback);
            if (idx > -1) listeners[eventName].splice(idx, 1);
          });
        }),
      };
    }

    return {
      mockCommands: {
        createClaudeSession: vi.fn(),
        sendClaudeMessage: vi.fn(),
        closeClaudeSession: vi.fn(),
      },
      mockEvents: {
        claudeSessionInitEvent: createEventListener("init"),
        claudeTextEvent: createEventListener("text"),
        claudeToolCallEvent: createEventListener("toolCall"),
        claudeToolResultEvent: createEventListener("toolResult"),
        claudePermissionRequestEvent: createEventListener("permission"),
        claudeSessionEndEvent: createEventListener("end"),
        claudeSessionErrorEvent: createEventListener("error"),
      },
      eventListeners: listeners,
      emitEvent: (eventName: string, payload: Record<string, unknown>) => {
        const eventListeners = listeners[eventName] || [];
        eventListeners.forEach((callback) => callback({ payload }));
      },
    };
  }
);

// Mock the bindings module
vi.mock("../bindings", () => ({
  commands: mockCommands,
  events: mockEvents,
}));

// Import after mock
import { useClaudeChat, type ChatMessage } from "./useClaudeChat";

describe("useClaudeChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear event listeners
    Object.keys(eventListeners).forEach((key) => {
      eventListeners[key] = [];
    });
    // Reset default mock implementations
    mockCommands.createClaudeSession.mockResolvedValue({ status: "ok" });
    mockCommands.sendClaudeMessage.mockResolvedValue({ status: "ok" });
    mockCommands.closeClaudeSession.mockResolvedValue({ status: "ok" });
  });

  describe("initial state", () => {
    it("starts with empty messages", () => {
      const { result } = renderHook(() => useClaudeChat());
      expect(result.current.messages).toEqual([]);
    });

    it("starts with idle state", () => {
      const { result } = renderHook(() => useClaudeChat());
      expect(result.current.state).toBe("idle");
    });

    it("starts with no session ID", () => {
      const { result } = renderHook(() => useClaudeChat());
      expect(result.current.sessionId).toBeNull();
    });

    it("starts with no error", () => {
      const { result } = renderHook(() => useClaudeChat());
      expect(result.current.error).toBeNull();
    });

    it("isActive is false when idle", () => {
      const { result } = renderHook(() => useClaudeChat());
      expect(result.current.isActive).toBe(false);
    });

    it("hasEnded is false when idle", () => {
      const { result } = renderHook(() => useClaudeChat());
      expect(result.current.hasEnded).toBe(false);
    });

    it("starts with no context usage", () => {
      const { result } = renderHook(() => useClaudeChat());
      expect(result.current.contextUsage).toBeNull();
    });
  });

  describe("startSession", () => {
    it("transitions to starting then running state", async () => {
      const { result } = renderHook(() => useClaudeChat());

      expect(result.current.state).toBe("idle");

      await act(async () => {
        result.current.startSession();
      });

      expect(result.current.state).toBe("running");
      expect(result.current.isActive).toBe(true);
    });

    it("creates a session with the Tauri command", async () => {
      const { result } = renderHook(() => useClaudeChat());

      await act(async () => {
        result.current.startSession();
      });

      expect(mockCommands.createClaudeSession).toHaveBeenCalledTimes(1);
      expect(mockCommands.createClaudeSession).toHaveBeenCalledWith(
        expect.stringContaining("claude-chat-"),
        null,
        null,
        null
      );
    });

    it("passes working directory to command", async () => {
      const { result } = renderHook(() =>
        useClaudeChat({ workingDir: "/test/path" })
      );

      await act(async () => {
        result.current.startSession();
      });

      expect(mockCommands.createClaudeSession).toHaveBeenCalledWith(
        expect.stringContaining("claude-chat-"),
        "/test/path",
        null,
        null
      );
    });

    it("adds user message when starting with initial prompt", async () => {
      const { result } = renderHook(() => useClaudeChat());

      await act(async () => {
        result.current.startSession("Hello Claude");
      });

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0]).toMatchObject({
        kind: "user",
        text: "Hello Claude",
      });
    });

    it("passes initial prompt to command", async () => {
      const { result } = renderHook(() => useClaudeChat());

      await act(async () => {
        result.current.startSession("Hello Claude");
      });

      expect(mockCommands.createClaudeSession).toHaveBeenCalledWith(
        expect.any(String),
        null,
        "Hello Claude",
        null
      );
    });

    it("handles session creation error", async () => {
      mockCommands.createClaudeSession.mockResolvedValue({
        status: "error",
        error: { SpawnFailed: "Failed to spawn Claude process" },
      });

      const { result } = renderHook(() => useClaudeChat());

      await act(async () => {
        result.current.startSession();
      });

      expect(result.current.state).toBe("error");
      expect(result.current.error).toBe("Failed to spawn Claude process");
    });

    it("prevents starting when already running", async () => {
      const { result } = renderHook(() => useClaudeChat());

      await act(async () => {
        result.current.startSession();
      });

      mockCommands.createClaudeSession.mockClear();

      await act(async () => {
        result.current.startSession();
      });

      expect(mockCommands.createClaudeSession).not.toHaveBeenCalled();
    });
  });

  describe("sendMessage", () => {
    it("sends message when session is active", async () => {
      const { result } = renderHook(() => useClaudeChat());

      await act(async () => {
        result.current.startSession();
      });

      await act(async () => {
        result.current.sendMessage("Hello");
      });

      expect(mockCommands.sendClaudeMessage).toHaveBeenCalledWith(
        expect.stringContaining("claude-chat-"),
        "Hello"
      );
    });

    it("adds user message immediately", async () => {
      const { result } = renderHook(() => useClaudeChat());

      await act(async () => {
        result.current.startSession();
      });

      await act(async () => {
        result.current.sendMessage("Hello");
      });

      const userMessages = result.current.messages.filter(
        (m) => m.kind === "user"
      );
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0]).toMatchObject({
        kind: "user",
        text: "Hello",
      });
    });

    it("does not send when session is not active", async () => {
      const { result } = renderHook(() => useClaudeChat());

      await act(async () => {
        result.current.sendMessage("Hello");
      });

      expect(mockCommands.sendClaudeMessage).not.toHaveBeenCalled();
    });

    it("adds error message on send failure", async () => {
      mockCommands.sendClaudeMessage.mockResolvedValue({
        status: "error",
        error: { SendFailed: "Connection lost" },
      });

      const { result } = renderHook(() => useClaudeChat());

      await act(async () => {
        result.current.startSession();
      });

      await act(async () => {
        result.current.sendMessage("Hello");
      });

      const errorMessages = result.current.messages.filter(
        (m) => m.kind === "error"
      );
      expect(errorMessages).toHaveLength(1);
      expect(errorMessages[0]).toMatchObject({
        kind: "error",
        message: "Failed to send message",
      });
    });
  });

  describe("closeSession", () => {
    it("closes the session and transitions to ended state", async () => {
      const { result } = renderHook(() => useClaudeChat());

      await act(async () => {
        result.current.startSession();
      });

      await act(async () => {
        result.current.closeSession();
      });

      expect(mockCommands.closeClaudeSession).toHaveBeenCalled();
      expect(result.current.state).toBe("ended");
      expect(result.current.hasEnded).toBe(true);
    });

    it("does nothing when no session exists", async () => {
      const { result } = renderHook(() => useClaudeChat());

      await act(async () => {
        result.current.closeSession();
      });

      expect(mockCommands.closeClaudeSession).not.toHaveBeenCalled();
    });
  });

  describe("clearMessages", () => {
    it("clears all messages", async () => {
      const { result } = renderHook(() => useClaudeChat());

      await act(async () => {
        result.current.startSession("Hello");
      });

      expect(result.current.messages.length).toBeGreaterThan(0);

      act(() => {
        result.current.clearMessages();
      });

      expect(result.current.messages).toEqual([]);
    });
  });

  describe("event handling", () => {
    it("handles session init event", async () => {
      const { result } = renderHook(() => useClaudeChat());

      await act(async () => {
        result.current.startSession();
      });

      const sessionId = result.current.sessionId;

      await act(async () => {
        emitEvent("init", {
          session_id: sessionId,
          model: "claude-3-sonnet",
          claude_conversation_id: "conv-123",
        });
      });

      expect(result.current.claudeConversationId).toBe("conv-123");
      expect(result.current.messages).toContainEqual(
        expect.objectContaining({
          kind: "session_start",
          model: "claude-3-sonnet",
        })
      );
    });

    it("handles text events for streaming", async () => {
      const { result } = renderHook(() => useClaudeChat());

      await act(async () => {
        result.current.startSession();
      });

      const sessionId = result.current.sessionId;

      // First partial message
      await act(async () => {
        emitEvent("text", {
          session_id: sessionId,
          text: "Hello",
          is_partial: true,
        });
      });

      let assistantMsgs = result.current.messages.filter(
        (m) => m.kind === "assistant"
      ) as Array<ChatMessage & { kind: "assistant" }>;
      expect(assistantMsgs).toHaveLength(1);
      expect(assistantMsgs[0].text).toBe("Hello");
      expect(assistantMsgs[0].isPartial).toBe(true);

      // Second partial - appends to existing
      await act(async () => {
        emitEvent("text", {
          session_id: sessionId,
          text: " World",
          is_partial: true,
        });
      });

      assistantMsgs = result.current.messages.filter(
        (m) => m.kind === "assistant"
      ) as Array<ChatMessage & { kind: "assistant" }>;
      expect(assistantMsgs).toHaveLength(1);
      expect(assistantMsgs[0].text).toBe("Hello World");
      expect(assistantMsgs[0].isPartial).toBe(true);

      // Final complete message - replaces partial
      await act(async () => {
        emitEvent("text", {
          session_id: sessionId,
          text: "Hello World!",
          is_partial: false,
        });
      });

      assistantMsgs = result.current.messages.filter(
        (m) => m.kind === "assistant"
      ) as Array<ChatMessage & { kind: "assistant" }>;
      expect(assistantMsgs).toHaveLength(1);
      expect(assistantMsgs[0].text).toBe("Hello World!");
      expect(assistantMsgs[0].isPartial).toBe(false);
    });

    it("handles tool call events", async () => {
      const { result } = renderHook(() => useClaudeChat());

      await act(async () => {
        result.current.startSession();
      });

      const sessionId = result.current.sessionId;

      await act(async () => {
        emitEvent("toolCall", {
          session_id: sessionId,
          tool_name: "Read",
          tool_id: "tool-123",
          input: '{"file": "test.ts"}',
        });
      });

      expect(result.current.messages).toContainEqual(
        expect.objectContaining({
          kind: "tool_call",
          toolName: "Read",
          toolId: "tool-123",
          input: '{"file": "test.ts"}',
        })
      );
    });

    it("handles tool result events", async () => {
      const { result } = renderHook(() => useClaudeChat());

      await act(async () => {
        result.current.startSession();
      });

      const sessionId = result.current.sessionId;

      await act(async () => {
        emitEvent("toolResult", {
          session_id: sessionId,
          tool_id: "tool-123",
          result: "File contents...",
          is_error: false,
        });
      });

      expect(result.current.messages).toContainEqual(
        expect.objectContaining({
          kind: "tool_result",
          toolId: "tool-123",
          result: "File contents...",
          isError: false,
        })
      );
    });

    it("handles permission request events", async () => {
      const { result } = renderHook(() => useClaudeChat());

      await act(async () => {
        result.current.startSession();
      });

      const sessionId = result.current.sessionId;

      await act(async () => {
        emitEvent("permission", {
          session_id: sessionId,
          tool_name: "Bash",
          permission_message: "Run shell command: ls -la",
        });
      });

      expect(result.current.messages).toContainEqual(
        expect.objectContaining({
          kind: "permission_request",
          toolName: "Bash",
          message: "Run shell command: ls -la",
        })
      );
    });

    it("handles session end events with context usage", async () => {
      const { result } = renderHook(() => useClaudeChat());

      await act(async () => {
        result.current.startSession();
      });

      const sessionId = result.current.sessionId;

      await act(async () => {
        emitEvent("end", {
          session_id: sessionId,
          duration_ms: 5000,
          cost_usd: 0.05,
          num_turns: 3,
          context_tokens: 10000,
          context_window: 200000,
        });
      });

      expect(result.current.state).toBe("ended");
      expect(result.current.hasEnded).toBe(true);
      expect(result.current.contextUsage).toEqual({
        tokens: 10000,
        window: 200000,
        percentage: 5,
      });
      expect(result.current.messages).toContainEqual(
        expect.objectContaining({
          kind: "session_end",
          durationMs: 5000,
          costUsd: 0.05,
          numTurns: 3,
        })
      );
    });

    it("handles session error events", async () => {
      const { result } = renderHook(() => useClaudeChat());

      await act(async () => {
        result.current.startSession();
      });

      const sessionId = result.current.sessionId;

      await act(async () => {
        emitEvent("error", {
          session_id: sessionId,
          error: "Connection lost",
        });
      });

      expect(result.current.state).toBe("error");
      expect(result.current.error).toBe("Connection lost");
      expect(result.current.messages).toContainEqual(
        expect.objectContaining({
          kind: "error",
          message: "Connection lost",
        })
      );
    });

    it("ignores events from other sessions", async () => {
      const { result } = renderHook(() => useClaudeChat());

      await act(async () => {
        result.current.startSession();
      });

      const initialMessageCount = result.current.messages.length;

      await act(async () => {
        emitEvent("text", {
          session_id: "different-session-id",
          text: "Should be ignored",
          is_partial: false,
        });
      });

      expect(result.current.messages.length).toBe(initialMessageCount);
    });
  });

  describe("session resumption", () => {
    it("uses stored conversation ID for resuming sessions", async () => {
      const { result } = renderHook(() => useClaudeChat());

      // Start first session
      await act(async () => {
        result.current.startSession("First message");
      });

      const sessionId = result.current.sessionId;

      // Receive init event with conversation ID
      await act(async () => {
        emitEvent("init", {
          session_id: sessionId,
          model: "claude-3-sonnet",
          claude_conversation_id: "conv-abc123",
        });
      });

      // End the session
      await act(async () => {
        emitEvent("end", {
          session_id: sessionId,
          duration_ms: 1000,
          cost_usd: 0.01,
          num_turns: 1,
          context_tokens: 1000,
          context_window: 200000,
        });
      });

      expect(result.current.state).toBe("ended");

      // Clear the mock to track next call
      mockCommands.createClaudeSession.mockClear();

      // Start new session - should resume with conversation ID
      await act(async () => {
        result.current.startSession("Second message");
      });

      expect(mockCommands.createClaudeSession).toHaveBeenCalledWith(
        expect.any(String),
        null,
        "Second message",
        "conv-abc123"
      );
    });
  });
});
