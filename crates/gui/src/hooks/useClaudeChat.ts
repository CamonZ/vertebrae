import { useCallback, useEffect, useRef, useState } from "react";
import { commands, events } from "../bindings";

/**
 * Message types for the Claude chat
 */
export type ChatMessage =
  | { kind: "user"; text: string; timestamp: string }
  | { kind: "assistant"; text: string; timestamp: string; isPartial?: boolean }
  | {
      kind: "tool_call";
      toolName: string;
      toolId: string;
      input: string;
      timestamp: string;
    }
  | {
      kind: "tool_result";
      toolId: string;
      result: string;
      isError: boolean;
      timestamp: string;
    }
  | {
      kind: "permission_request";
      toolName: string;
      message: string;
      timestamp: string;
    }
  | { kind: "session_start"; model: string; timestamp: string }
  | {
      kind: "session_end";
      durationMs: number;
      costUsd: number;
      numTurns: number;
      timestamp: string;
    }
  | { kind: "error"; message: string; timestamp: string };

/**
 * Session state for Claude chat
 */
export type ClaudeChatState =
  | "idle"
  | "starting"
  | "running"
  | "ended"
  | "error";

/**
 * Options for useClaudeChat hook
 */
export interface UseClaudeChatOptions {
  /** Working directory for the Claude session */
  workingDir?: string;
}

/**
 * Hook to manage a Claude CLI chat session with JSONL streaming
 *
 * Provides structured message handling instead of raw terminal output.
 */
export function useClaudeChat(options: UseClaudeChatOptions = {}) {
  const { workingDir } = options;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<ClaudeChatState>("idle");
  const [error, setError] = useState<string | null>(null);
  
  // Claude's conversation ID for resuming sessions
  const [claudeConversationId, setClaudeConversationId] = useState<string | null>(null);
  
  // Context usage tracking
  const [contextUsage, setContextUsage] = useState<{
    tokens: number;
    window: number;
    percentage: number;
  } | null>(null);

  // Store session ID in ref for event handlers
  const sessionIdRef = useRef<string | null>(null);
  // Store Claude conversation ID in ref for event handlers
  const claudeConversationIdRef = useRef<string | null>(null);

  // Generate unique session ID
  const generateSessionId = useCallback(() => {
    return `claude-chat-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }, []);

  /**
   * Start a new Claude session
   */
  const startSession = useCallback(
    async (initialPrompt?: string) => {
      if (state === "running" || state === "starting") {
        return;
      }

      const newSessionId = generateSessionId();
      setState("starting");
      setError(null);
      // Don't clear messages - keep conversation history visible
      // User can explicitly call clearMessages() if they want a fresh start

      // Add user message immediately if there's an initial prompt
      if (initialPrompt) {
        setMessages((prev) => [
          ...prev,
          {
            kind: "user",
            text: initialPrompt,
            timestamp: new Date().toISOString(),
          },
        ]);
      }

      // Use stored Claude conversation ID to resume, if available
      const resumeId = claudeConversationIdRef.current;
      
      const result = await commands.createClaudeSession(
        newSessionId,
        workingDir ?? null,
        initialPrompt ?? null,
        resumeId
      );

      if (result.status === "error") {
        const errorMsg =
          "SessionExists" in result.error
            ? result.error.SessionExists
            : "SessionNotFound" in result.error
              ? result.error.SessionNotFound
              : "SendFailed" in result.error
                ? result.error.SendFailed
                : "SpawnFailed" in result.error
                  ? result.error.SpawnFailed
                  : "Unknown error";
        setState("error");
        setError(errorMsg);
        return;
      }

      setSessionId(newSessionId);
      sessionIdRef.current = newSessionId;
      setState("running");
    },
    [state, generateSessionId, workingDir]
  );

  /**
   * Send a message to the Claude session
   */
  const sendMessage = useCallback(
    async (content: string) => {
      if (!sessionId || state !== "running") {
        return;
      }

      // Add user message immediately
      setMessages((prev) => [
        ...prev,
        {
          kind: "user",
          text: content,
          timestamp: new Date().toISOString(),
        },
      ]);

      const result = await commands.sendClaudeMessage(sessionId, content);

      if (result.status === "error") {
        setMessages((prev) => [
          ...prev,
          {
            kind: "error",
            message: "Failed to send message",
            timestamp: new Date().toISOString(),
          },
        ]);
      }
    },
    [sessionId, state]
  );

  /**
   * Close the Claude session
   */
  const closeSession = useCallback(async () => {
    if (!sessionId) {
      return;
    }

    await commands.closeClaudeSession(sessionId);
    setState("ended");
  }, [sessionId]);

  /**
   * Clear messages and reset state
   */
  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  // Subscribe to Claude events
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let isCancelled = false;

    const setupListeners = async () => {
      // Session init
      const initUn = await events.claudeSessionInitEvent.listen((event) => {
        if (event.payload.session_id === sessionIdRef.current) {
          // Store Claude's conversation ID for --resume support
          if (event.payload.claude_conversation_id) {
            claudeConversationIdRef.current = event.payload.claude_conversation_id;
            setClaudeConversationId(event.payload.claude_conversation_id);
          }
          setMessages((prev) => [
            ...prev,
            {
              kind: "session_start",
              model: event.payload.model,
              timestamp: new Date().toISOString(),
            },
          ]);
        }
      });
      if (isCancelled) {
        initUn();
        return;
      }
      unlisteners.push(initUn);

      // Text output
      const textUn = await events.claudeTextEvent.listen((event) => {
        if (event.payload.session_id === sessionIdRef.current) {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            
            // If this is a partial message (streaming)
            if (event.payload.is_partial) {
              // If last message is partial assistant, append to it
              if (last?.kind === "assistant" && last.isPartial) {
                return [
                  ...prev.slice(0, -1),
                  { ...last, text: last.text + event.payload.text },
                ];
              }
              // Otherwise start a new partial message
              return [
                ...prev,
                {
                  kind: "assistant",
                  text: event.payload.text,
                  timestamp: new Date().toISOString(),
                  isPartial: true,
                },
              ];
            }
            
            // Non-partial (complete) message
            // If last message is partial assistant, replace it with the complete version
            if (last?.kind === "assistant" && last.isPartial) {
              return [
                ...prev.slice(0, -1),
                {
                  kind: "assistant",
                  text: event.payload.text,
                  timestamp: last.timestamp, // Keep original timestamp
                  isPartial: false,
                },
              ];
            }
            
            // Otherwise add new complete message
            return [
              ...prev,
              {
                kind: "assistant",
                text: event.payload.text,
                timestamp: new Date().toISOString(),
                isPartial: false,
              },
            ];
          });
        }
      });
      if (isCancelled) {
        textUn();
        return;
      }
      unlisteners.push(textUn);

      // Tool calls
      const toolCallUn = await events.claudeToolCallEvent.listen((event) => {
        if (event.payload.session_id === sessionIdRef.current) {
          setMessages((prev) => [
            ...prev,
            {
              kind: "tool_call",
              toolName: event.payload.tool_name,
              toolId: event.payload.tool_id,
              input: event.payload.input,
              timestamp: new Date().toISOString(),
            },
          ]);
        }
      });
      if (isCancelled) {
        toolCallUn();
        return;
      }
      unlisteners.push(toolCallUn);

      // Tool results
      const toolResultUn = await events.claudeToolResultEvent.listen(
        (event) => {
          if (event.payload.session_id === sessionIdRef.current) {
            setMessages((prev) => [
              ...prev,
              {
                kind: "tool_result",
                toolId: event.payload.tool_id,
                result: event.payload.result,
                isError: event.payload.is_error,
                timestamp: new Date().toISOString(),
              },
            ]);
          }
        }
      );
      if (isCancelled) {
        toolResultUn();
        return;
      }
      unlisteners.push(toolResultUn);

      // Permission requests
      const permissionUn = await events.claudePermissionRequestEvent.listen(
        (event) => {
          if (event.payload.session_id === sessionIdRef.current) {
            setMessages((prev) => [
              ...prev,
              {
                kind: "permission_request",
                toolName: event.payload.tool_name,
                message: event.payload.permission_message,
                timestamp: new Date().toISOString(),
              },
            ]);
          }
        }
      );
      if (isCancelled) {
        permissionUn();
        return;
      }
      unlisteners.push(permissionUn);

      // Session end
      const endUn = await events.claudeSessionEndEvent.listen((event) => {
        if (event.payload.session_id === sessionIdRef.current) {
          setState("ended");
          
          // Update context usage
          const tokens = event.payload.context_tokens;
          const window = event.payload.context_window;
          if (window > 0) {
            setContextUsage({
              tokens,
              window,
              percentage: Math.round((tokens / window) * 100),
            });
          }
          
          setMessages((prev) => [
            ...prev,
            {
              kind: "session_end",
              durationMs: event.payload.duration_ms,
              costUsd: event.payload.cost_usd,
              numTurns: event.payload.num_turns,
              timestamp: new Date().toISOString(),
            },
          ]);
        }
      });
      if (isCancelled) {
        endUn();
        return;
      }
      unlisteners.push(endUn);

      // Session error
      const errorUn = await events.claudeSessionErrorEvent.listen((event) => {
        if (event.payload.session_id === sessionIdRef.current) {
          setState("error");
          setError(event.payload.error);
          setMessages((prev) => [
            ...prev,
            {
              kind: "error",
              message: event.payload.error,
              timestamp: new Date().toISOString(),
            },
          ]);
        }
      });
      if (isCancelled) {
        errorUn();
        return;
      }
      unlisteners.push(errorUn);
    };

    setupListeners();

    return () => {
      isCancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  // Cleanup session on unmount
  useEffect(() => {
    return () => {
      if (sessionIdRef.current) {
        commands.closeClaudeSession(sessionIdRef.current);
      }
    };
  }, []);

  return {
    /** Chat messages */
    messages,
    /** Current session ID */
    sessionId,
    /** Claude's conversation ID for resuming */
    claudeConversationId,
    /** Session state */
    state,
    /** Error message if any */
    error,
    /** Context window usage */
    contextUsage,
    /** Start a new session */
    startSession,
    /** Send a message */
    sendMessage,
    /** Close the session */
    closeSession,
    /** Clear all messages */
    clearMessages,
    /** Whether the session is active */
    isActive: state === "running",
    /** Whether the session has ended */
    hasEnded: state === "ended",
  };
}
