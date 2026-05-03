import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useScopedChat } from "../../hooks/useScopedChat";
import { useChatStore, getParentScope } from "../../stores/chatStore";
import type { ChatScope, ChatMessage } from "../../stores/chatStore";
import { scopeLabel } from "../../utils/chatContext";
import { MarkdownContent } from "../shared/MarkdownContent";

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
            <MarkdownContent text={message.text} />
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
            <MarkdownContent text={message.text} />
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
            <p className="mt-2 text-sm text-text-secondary">{message.message}</p>
            <p className="mt-2 text-xs text-text-muted">
              Grant permission in the Claude CLI terminal to continue.
            </p>
          </div>
        </div>
      );

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
 * Scope breadcrumb showing current scope with widen control
 */
function ScopeBreadcrumb({
  scope,
  label,
  onWiden,
}: {
  scope: ChatScope;
  label: string;
  onWiden: (() => void) | null;
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-primary">
        {scopeLabel(scope)}
      </span>
      <span className="max-w-[150px] truncate text-text-secondary" title={label}>
        {label}
      </span>
      {onWiden && (
        <button
          onClick={onWiden}
          className="ml-1 rounded p-0.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          title={`Widen scope to ${scopeLabel(getParentScope(scope)!)}`}
        >
          <svg
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

interface ChatWindowProps {
  sessionId: string;
}

/**
 * ChatWindow renders a single chat session with message list, input, and scope header.
 */
export function ChatWindow({ sessionId }: ChatWindowProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [inputValue, setInputValue] = useState("");

  const { session, isActive, startSession, sendMessage, closeClaudeSession } =
    useScopedChat(sessionId);

  const clearMessages = useChatStore((s) => s.clearMessages);
  const widenScope = useChatStore((s) => s.widenScope);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session?.messages]);

  // Focus input when session becomes active
  useEffect(() => {
    if (isActive) {
      inputRef.current?.focus();
    }
  }, [isActive]);

  const handleSend = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed || !isActive) return;
    sendMessage(trimmed);
    setInputValue("");
  }, [inputValue, isActive, sendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (isActive) {
          handleSend();
        } else if (inputValue.trim()) {
          startSession(inputValue.trim());
          setInputValue("");
        }
      }
    },
    [handleSend, isActive, inputValue, startSession]
  );

  const handleStartSession = useCallback(() => {
    const initialPrompt = inputValue.trim();
    startSession(initialPrompt || undefined);
    setInputValue("");
  }, [inputValue, startSession]);

  const handleWiden = useCallback(() => {
    if (!session) return;
    const parentScope = getParentScope(session.scope);
    if (!parentScope) return;

    // When widening, we lose the specific entity context and go up
    // For step->task, we'd need the task ID; for simplicity, we set entityId to null
    // and let the context re-inject at the broader scope level
    widenScope(
      sessionId,
      parentScope,
      null,
      `${scopeLabel(parentScope)} Chat`
    );
  }, [session, sessionId, widenScope]);

  if (!session) return null;

  const canWiden = getParentScope(session.scope) !== null;
  const isWaiting =
    isActive &&
    session.messages.length > 0 &&
    session.messages[session.messages.length - 1].kind === "user";

  return (
    <div className="flex h-full flex-col">
      {/* Scope header */}
      <div className="flex items-center justify-between border-b border-border bg-bg-primary px-3 py-2">
        <ScopeBreadcrumb
          scope={session.scope}
          label={session.label}
          onWiden={canWiden ? handleWiden : null}
        />
        <div className="flex items-center gap-1">
          {/* Active indicator */}
          {isActive && (
            <span className="relative flex h-2 w-2">
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
          )}
          {session.status === "closed" && (
            <span className="relative inline-flex h-2 w-2 rounded-full bg-text-muted" />
          )}
          {isActive && (
            <button
              onClick={closeClaudeSession}
              className="ml-1 rounded p-1 text-error transition-colors hover:bg-error/10"
              title="End session"
            >
              <svg
                className="h-3.5 w-3.5"
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
            onClick={() => clearMessages(sessionId)}
            className="rounded p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
            title="Clear messages"
          >
            <svg
              className="h-3.5 w-3.5"
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
        </div>
      </div>

      {/* Context summary banner */}
      {session.contextSummary && (
        <div className="border-b border-border bg-bg-tertiary/50 px-3 py-1.5">
          <details className="text-xs text-text-muted">
            <summary className="cursor-pointer select-none hover:text-text-secondary">
              Context injected
            </summary>
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[11px]">
              {session.contextSummary}
            </pre>
          </details>
        </div>
      )}

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto p-4">
        {session.messages.length === 0 && !isActive && (
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
              Chat scoped to {scopeLabel(session.scope).toLowerCase()}
            </p>
            <p className="mt-1 text-xs text-text-muted">
              Type a message and press Enter to begin
            </p>
          </div>
        )}

        <div className="flex flex-col gap-3">
          {session.messages.map((msg, i) => (
            <ChatMessageItem key={i} message={msg} />
          ))}
          {isWaiting && <ThinkingIndicator />}
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
          />
          <button
            onClick={isActive ? handleSend : handleStartSession}
            disabled={!inputValue.trim() && !isActive}
            className="flex h-auto items-center justify-center rounded-lg bg-primary px-3 text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            title={isActive ? "Send message" : "Start session"}
          >
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
          </button>
        </div>
      </div>
    </div>
  );
}
