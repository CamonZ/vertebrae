import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useClaudeChat, type ChatMessage } from "../hooks/useClaudeChat";
import { commands } from "../bindings";
import { useUIStore } from "../stores";
import { ResizablePanel } from "./ResizablePanel";

/**
 * Thinking indicator shown while waiting for Claude to respond
 */
function ThinkingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-2 rounded-lg bg-bg-tertiary px-4 py-3">
        <div className="flex gap-1">
          <span className="h-2 w-2 animate-bounce rounded-full bg-primary [animation-delay:-0.3s]" />
          <span className="h-2 w-2 animate-bounce rounded-full bg-primary [animation-delay:-0.15s]" />
          <span className="h-2 w-2 animate-bounce rounded-full bg-primary" />
        </div>
        <span className="text-sm text-text-muted">Thinking...</span>
      </div>
    </div>
  );
}

/**
 * Renders a single chat message based on its kind
 * Memoized to prevent re-renders when parent state changes (like input value)
 */
const ChatMessageItem = memo(function ChatMessageItem({
  message,
}: {
  message: ChatMessage;
}) {
  switch (message.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-lg bg-primary/20 px-4 py-3">
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-text-primary antialiased">
              {message.text}
            </p>
            <p className="mt-2 text-right text-xs text-text-muted">
              {new Date(message.timestamp).toLocaleTimeString()}
            </p>
          </div>
        </div>
      );

    case "assistant":
      return (
        <div className="flex justify-start">
          <div className="max-w-[85%] rounded-lg bg-bg-tertiary px-4 py-3">
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-text-primary antialiased">
              {message.text}
            </p>
            {message.isPartial && (
              <span className="ml-1 inline-block h-4 w-1 animate-pulse bg-primary" />
            )}
            <p className="mt-2 text-xs text-text-muted">
              {new Date(message.timestamp).toLocaleTimeString()}
            </p>
          </div>
        </div>
      );

    case "tool_call":
      return (
        <div className="flex justify-start">
          <div className="max-w-[90%] rounded-lg border border-accent/30 bg-accent/5 px-4 py-3">
            <div className="flex items-center gap-2">
              <svg
                className="h-4 w-4 text-accent"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
              <span className="font-mono text-sm font-medium text-accent">
                {message.toolName}
              </span>
            </div>
            <pre className="mt-2 max-h-40 overflow-auto rounded bg-bg-primary/50 p-3 font-mono text-[13px] leading-relaxed text-text-secondary antialiased">
              {message.input}
            </pre>
            <p className="mt-2 text-xs text-text-muted">
              {new Date(message.timestamp).toLocaleTimeString()}
            </p>
          </div>
        </div>
      );

    case "tool_result":
      return (
        <div className="flex justify-start">
          <div
            className={`max-w-[90%] rounded-lg border px-4 py-3 ${
              message.isError
                ? "border-error/30 bg-error/5"
                : "border-success/30 bg-success/5"
            }`}
          >
            <div className="flex items-center gap-2">
              {message.isError ? (
                <svg
                  className="h-4 w-4 text-error"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              ) : (
                <svg
                  className="h-4 w-4 text-success"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              )}
              <span
                className={`text-sm font-medium ${message.isError ? "text-error" : "text-success"}`}
              >
                {message.isError ? "Error" : "Result"}
              </span>
            </div>
            <pre className="mt-2 max-h-40 overflow-auto rounded bg-bg-primary/50 p-3 font-mono text-[13px] leading-relaxed text-text-secondary antialiased">
              {message.result}
            </pre>
          </div>
        </div>
      );

    case "permission_request":
      return (
        <div className="flex justify-center py-2">
          <div className="w-full rounded-lg border border-warning/30 bg-warning/10 px-4 py-3">
            <div className="flex items-center gap-2">
              <svg
                className="h-5 w-5 text-warning"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
              <span className="text-sm font-medium text-warning">
                Permission Required
              </span>
            </div>
            <p className="mt-2 text-sm text-text-secondary">
              {message.message}
            </p>
            <p className="mt-2 text-xs text-text-muted">
              Grant permission in the Claude CLI terminal to continue.
            </p>
          </div>
        </div>
      );

    // Hide session start/end messages - they clutter the conversation
    case "session_start":
    case "session_end":
      return null;

    case "error":
      return (
        <div className="flex justify-center py-2">
          <div className="rounded-lg bg-error/10 px-4 py-2">
            <p className="text-sm text-error">{message.message}</p>
          </div>
        </div>
      );
  }
});

/**
 * Claude Chat Sidebar - A structured chat interface using Claude CLI JSONL streaming
 */
export function ClaudeChatSidebar() {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [inputValue, setInputValue] = useState("");
  const [workingDir, setWorkingDir] = useState<string | null>(null);

  // Panel state from store
  const claudeSidebarOpen = useUIStore((s) => s.claudeSidebarOpen);
  const toggleClaudeSidebar = useUIStore((s) => s.toggleClaudeSidebar);

  // Claude chat hook
  const {
    messages,
    state,
    error,
    contextUsage,
    startSession,
    sendMessage,
    closeSession,
    clearMessages,
    isActive,
    hasEnded,
  } = useClaudeChat({ workingDir: workingDir ?? undefined });

  // Load current project working directory
  useEffect(() => {
    async function loadProject() {
      const result = await commands.getCurrentProjectPath();
      if (result.status === "ok" && result.data) {
        setWorkingDir(result.data);
      }
    }
    loadProject();
  }, []);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus input when sidebar opens
  useEffect(() => {
    if (claudeSidebarOpen && isActive) {
      inputRef.current?.focus();
    }
  }, [claudeSidebarOpen, isActive]);

  // Handle sending a message
  const handleSend = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed || !isActive) return;

    sendMessage(trimmed);
    setInputValue("");
  }, [inputValue, isActive, sendMessage]);

  // Handle key press in input
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (isActive) {
          handleSend();
        } else if (inputValue.trim()) {
          // Start session with initial prompt
          startSession(inputValue.trim());
          setInputValue("");
        }
      }
    },
    [handleSend, isActive, inputValue, startSession]
  );

  // Start new session
  const handleStartSession = useCallback(() => {
    const initialPrompt = inputValue.trim();
    startSession(initialPrompt || undefined);
    setInputValue("");
  }, [inputValue, startSession]);

  if (!claudeSidebarOpen) {
    return null;
  }

  return (
    <ResizablePanel
      storageKey="claude-chat-sidebar-width"
      defaultWidth={400}
      minWidth={300}
      glowColor="from-accent/0 via-accent/30 to-accent/0"
    >
      {/* Header */}
      <div className="relative flex items-center justify-between border-b border-border bg-bg-primary px-4 py-2">
        {/* Neural grid background */}
        <div className="neural-grid pointer-events-none absolute inset-0 opacity-20" />

        <div className="relative flex items-center gap-3">
          <h2 className="text-sm font-semibold text-text-primary">
            Claude Chat
          </h2>

          {/* Session status indicator */}
          {state === "starting" && (
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
          )}
          {isActive && (
            <span className="relative flex h-2 w-2">
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
          )}
          {hasEnded && (
            <span className="relative inline-flex h-2 w-2 rounded-full bg-text-muted" />
          )}
          {state === "error" && (
            <span className="relative inline-flex h-2 w-2 rounded-full bg-error" />
          )}
          
          {/* Context usage indicator */}
          {contextUsage && (
            <div className="flex items-center gap-1.5" title={`${contextUsage.tokens.toLocaleString()} / ${contextUsage.window.toLocaleString()} tokens`}>
              <div className="h-1.5 w-16 overflow-hidden rounded-full bg-bg-tertiary">
                <div 
                  className={`h-full rounded-full transition-all ${
                    contextUsage.percentage > 80 
                      ? 'bg-error' 
                      : contextUsage.percentage > 50 
                        ? 'bg-warning' 
                        : 'bg-primary'
                  }`}
                  style={{ width: `${Math.min(contextUsage.percentage, 100)}%` }}
                />
              </div>
              <span className="text-[10px] text-text-muted">
                {contextUsage.percentage}%
              </span>
            </div>
          )}
        </div>

        {/* Control buttons */}
        <div className="relative flex items-center gap-1">
          {isActive && (
            <button
              onClick={closeSession}
              className="rounded p-1.5 text-error transition-colors hover:bg-error/10"
              title="Close session"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          )}
          <button
            onClick={clearMessages}
            className="rounded p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
            title="Clear messages"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
          </button>
          <div className="mx-1 h-4 w-px bg-border" />
          <button
            onClick={toggleClaudeSidebar}
            className="rounded p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
            title="Close panel"
          >
            {/* Right chevron for closing right sidebar */}
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5l7 7-7 7"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Error message */}
      {error && state === "error" && (
        <div className="border-b border-error/30 bg-error/10 px-4 py-2">
          <p className="text-xs text-error">Session error: {error}</p>
          <button
            onClick={() => startSession()}
            className="mt-1 text-xs font-medium text-error underline hover:no-underline"
          >
            Start new session
          </button>
        </div>
      )}

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto p-4">
        {messages.length === 0 && state === "idle" && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <svg
                className="h-6 w-6 text-primary"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                />
              </svg>
            </div>
            <p className="text-sm text-text-secondary">
              Start a conversation with Claude
            </p>
            <p className="mt-1 text-xs text-text-muted">
              Type a message and press Enter to begin
            </p>
          </div>
        )}

        <div className="flex flex-col gap-3">
          {messages.map((msg, i) => (
            <ChatMessageItem key={i} message={msg} />
          ))}
          {/* Show thinking indicator when waiting for response */}
          {(state === "starting" ||
            (isActive &&
              messages.length > 0 &&
              messages[messages.length - 1].kind === "user")) && (
            <ThinkingIndicator />
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input area */}
      <div className="border-t border-border bg-bg-secondary p-3">
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isActive ? "Type a message..." : "Type a message to start..."
            }
            className="flex-1 resize-none rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            rows={2}
            disabled={state === "starting"}
          />
          <button
            onClick={isActive ? handleSend : handleStartSession}
            disabled={!inputValue.trim() && !isActive}
            className="flex h-auto items-center justify-center rounded-lg bg-primary px-3 text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            title={isActive ? "Send message" : "Start session"}
          >
            {state === "starting" ? (
              <svg
                className="h-5 w-5 animate-spin"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
            ) : (
              <svg
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                />
              </svg>
            )}
          </button>
        </div>
        {workingDir && (
          <p className="mt-2 truncate font-mono text-[10px] text-text-muted">
            Working in: {workingDir}
          </p>
        )}
      </div>
    </ResizablePanel>
  );
}
