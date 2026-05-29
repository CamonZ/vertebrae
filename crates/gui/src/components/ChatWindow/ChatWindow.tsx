import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useScopedChat } from "../../hooks/useScopedChat";
import { commands } from "../../bindings";
import type { JsonValue } from "../../bindings";
import { useChatStore, getParentScope } from "../../stores/chatStore";
import type { ChatScope, ChatMessage } from "../../stores/chatStore";
import { scopeLabel } from "../../utils/chatContext";
import {
  formatTokenCount,
  utilizationLevel,
  type UtilizationLevel,
} from "../../utils/modelContextWindow";
import { MarkdownContent } from "../shared/MarkdownContent";
import { ChatMessage as ChatBubble } from "../molecules/ChatMessage";
import {
  ToolCallBlock,
  type ToolCallState,
} from "../molecules/ToolCallBlock";
import { ChatInput } from "../ChatInput";

const LEVEL_CLASSES: Record<UtilizationLevel, string> = {
  danger: "border-[var(--color-err)]/40 bg-[var(--color-err)]/10 text-[var(--color-err)]",
  warn: "border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 text-[var(--color-warn)]",
  ok: "border-[var(--color-line)] bg-[var(--color-bg-2)] text-[var(--color-fg-mute)]",
};

function ContextUtilizationBadge({
  model,
  used,
  max,
}: {
  model?: string;
  used: number;
  max: number;
}) {
  const level = utilizationLevel(used, max);
  const pct = max > 0 ? Math.round((used / max) * 100) : 0;
  const modelLabel = model?.replace(/^claude-/i, "");

  return (
    <span
      className={`rounded border px-1.5 py-0.5 font-mono text-eyebrow ${LEVEL_CLASSES[level]}`}
      title={`${used.toLocaleString()} / ${max.toLocaleString()} input tokens (${pct}%)`}
    >
      {modelLabel ? `${modelLabel} · ` : ""}
      {formatTokenCount(used)} / {formatTokenCount(max)} ({pct}%)
    </span>
  );
}

/**
 * Thinking indicator shown while waiting for Claude to respond
 */
function ThinkingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-2 rounded-lg bg-[var(--color-bg-2)] px-4 py-3">
        <div className="flex gap-1">
          <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--color-accent)] [animation-delay:-0.3s]" />
          <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--color-accent)] [animation-delay:-0.15s]" />
          <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--color-accent)]" />
        </div>
        <span className="text-sm text-[var(--color-fg-mute)]">Thinking...</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Turn grouping
// ---------------------------------------------------------------------------
//
// chatStore emits each Claude event as a sibling `ChatMessage`. The UI groups
// tool_call + tool_result siblings INTO the preceding assistant message so the
// conversation reads as turns (one bubble per assistant reply, tool calls
// nested as `ToolCallBlock` children) rather than a flat event list.

interface PendingTool {
  toolName: string;
  toolId: string;
  input: string;
  state: ToolCallState;
  result?: string;
  timestamp: string;
}

interface AssistantTurn {
  kind: "assistant";
  text: string;
  timestamp: string;
  isPartial?: boolean;
  tools: PendingTool[];
}

interface SimpleTurn {
  kind: "user" | "permission_request" | "error";
  message: ChatMessage;
}

type Turn = AssistantTurn | SimpleTurn;

function groupChatMessages(messages: readonly ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  let activeAssistant: AssistantTurn | null = null;

  for (const m of messages) {
    switch (m.kind) {
      case "session_start":
      case "session_end":
        continue;
      case "user":
        activeAssistant = null;
        turns.push({ kind: "user", message: m });
        continue;
      case "assistant":
        activeAssistant = {
          kind: "assistant",
          text: m.text,
          timestamp: m.timestamp,
          isPartial: m.isPartial,
          tools: [],
        };
        turns.push(activeAssistant);
        continue;
      case "tool_call":
        if (!activeAssistant) {
          // Tool call before any assistant turn — open a headless assistant
          // bubble so the tool block has a container.
          activeAssistant = {
            kind: "assistant",
            text: "",
            timestamp: m.timestamp,
            tools: [],
          };
          turns.push(activeAssistant);
        }
        activeAssistant.tools.push({
          toolName: m.toolName,
          toolId: m.toolId,
          input: m.input,
          state: "pending",
          timestamp: m.timestamp,
        });
        continue;
      case "tool_result": {
        const slot = activeAssistant?.tools.find(
          (t) => t.toolId === m.toolId && t.state === "pending"
        );
        if (slot) {
          slot.result = m.result;
          slot.state = m.isError ? "error" : "success";
        }
        continue;
      }
      case "permission_request":
      case "error":
        activeAssistant = null;
        turns.push({ kind: m.kind, message: m });
        continue;
    }
  }
  return turns;
}

function renderTurn(turn: Turn, key: string): ReactNode {
  if (turn.kind === "user") {
    const msg = turn.message as Extract<ChatMessage, { kind: "user" }>;
    return (
      <ChatBubble
        key={key}
        role="user"
        author="YOU"
        timestamp={new Date(msg.timestamp).toLocaleTimeString()}
      >
        <MarkdownContent text={msg.text} />
      </ChatBubble>
    );
  }

  if (turn.kind === "assistant") {
    return (
      <ChatBubble
        key={key}
        role="assistant"
        author="CLAUDE"
        timestamp={new Date(turn.timestamp).toLocaleTimeString()}
        streaming={turn.isPartial}
      >
        {turn.text.length > 0 && <MarkdownContent text={turn.text} />}
        {turn.tools.map((t, i) => (
          <ToolCallBlock
            key={`${t.toolId}-${i}`}
            toolName={t.toolName}
            state={t.state}
            input={t.input}
            result={t.result}
          />
        ))}
      </ChatBubble>
    );
  }

  if (turn.kind === "permission_request") {
    const msg = turn.message as Extract<
      ChatMessage,
      { kind: "permission_request" }
    >;
    return <PermissionRequestTurn key={key} message={msg} />;
  }

  // error
  const msg = turn.message as Extract<ChatMessage, { kind: "error" }>;
  return (
    <ChatBubble key={key} role="system" author="ERROR">
      <p className="text-sm text-[var(--color-err)]">{msg.message}</p>
    </ChatBubble>
  );
}

function PermissionRequestTurn({
  message,
}: {
  message: Extract<ChatMessage, { kind: "permission_request" }>;
}) {
  const [updatedInput, setUpdatedInput] = useState(message.input ?? "");
  const [status, setStatus] = useState<"pending" | "allowing" | "denying" | "resolved" | "error">(
    message.requestId ? "pending" : "resolved"
  );
  const [error, setError] = useState<string | null>(null);

  const resolve = async (behavior: "allow" | "deny") => {
    if (!message.requestId) return;
    setStatus(behavior === "allow" ? "allowing" : "denying");
    setError(null);

    let parsedInput: JsonValue | null = null;
    if (behavior === "allow" && updatedInput.trim()) {
      try {
        parsedInput = JSON.parse(updatedInput) as JsonValue;
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : "Invalid JSON");
        return;
      }
    }

    const result = await commands.resolvePermissionRequest({
      request_id: message.requestId,
      behavior,
      message: behavior === "deny" ? "Denied from Vertebrae GUI" : null,
      updated_input: behavior === "allow" ? parsedInput : null,
    });

    if (result.status === "ok") {
      setStatus("resolved");
    } else {
      setStatus("error");
      setError(result.error.message);
    }
  };

  const disabled = status === "allowing" || status === "denying" || status === "resolved";

  return (
    <ChatBubble role="system" author="PERMISSION REQUIRED">
      <div className="space-y-3">
        <div>
          <p className="font-mono text-xs text-[var(--color-fg)]">{message.toolName}</p>
          <p className="mt-1 text-sm text-[var(--color-fg-soft)]">{message.message}</p>
        </div>
        {message.input && (
          <textarea
            value={updatedInput}
            onChange={(event) => setUpdatedInput(event.target.value)}
            disabled={disabled}
            className="h-32 w-full resize-y rounded border border-[var(--color-line)] bg-[var(--color-bg)] p-2 font-mono text-xs text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
            spellCheck={false}
          />
        )}
        {error && <p className="text-xs text-[var(--color-err)]">{error}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => void resolve("allow")}
            className="rounded border border-[var(--color-ok)]/40 px-3 py-1.5 text-xs font-medium text-[var(--color-ok)] transition-colors hover:bg-[var(--color-ok)]/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === "allowing" ? "Approving..." : "Approve"}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => void resolve("deny")}
            className="rounded border border-[var(--color-err)]/40 px-3 py-1.5 text-xs font-medium text-[var(--color-err)] transition-colors hover:bg-[var(--color-err)]/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === "denying" ? "Denying..." : "Deny"}
          </button>
          {status === "resolved" && (
            <span className="self-center text-xs text-[var(--color-fg-mute)]">Resolved</span>
          )}
        </div>
      </div>
    </ChatBubble>
  );
}

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
      <span className="rounded bg-[var(--color-accent)]/10 px-1.5 py-0.5 font-mono text-2xs uppercase tracking-wider text-[var(--color-accent)]">
        {scopeLabel(scope)}
      </span>
      <span className="max-w-[150px] truncate text-[var(--color-fg-soft)]" title={label}>
        {label}
      </span>
      {onWiden && (
        <button
          onClick={onWiden}
          className="ml-1 rounded p-0.5 text-[var(--color-fg-mute)] transition-colors hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
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

  const turns = useMemo(
    () => groupChatMessages(session?.messages ?? []),
    [session?.messages]
  );

  if (!session) return null;

  const canWiden = getParentScope(session.scope) !== null;
  const isWaiting =
    isActive &&
    session.messages.length > 0 &&
    session.messages[session.messages.length - 1].kind === "user";

  return (
    <div className="flex h-full flex-col">
      {/* Scope header */}
      <div className="flex items-center justify-between border-b border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2">
        <ScopeBreadcrumb
          scope={session.scope}
          label={session.label}
          onWiden={canWiden ? handleWiden : null}
        />
        <div className="flex items-center gap-1.5">
          {session.tokenUsage && (
            <ContextUtilizationBadge
              model={session.model}
              used={session.tokenUsage.used}
              max={session.tokenUsage.max}
            />
          )}
          {/* Active indicator */}
          {isActive && (
            <span className="relative flex h-2 w-2">
              <span
                data-testid="chat-active-dot"
                className="relative inline-flex h-2 w-2 rounded-full bg-[var(--color-ok)]"
              />
            </span>
          )}
          {session.status === "closed" && (
            <span
              data-testid="chat-closed-dot"
              className="relative inline-flex h-2 w-2 rounded-full bg-[var(--color-fg-mute)]"
            />
          )}
          {isActive && (
            <button
              onClick={closeClaudeSession}
              className="ml-1 rounded p-1 text-[var(--color-err)] transition-colors hover:bg-[var(--color-err)]/10"
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
            className="rounded p-1 text-[var(--color-fg-mute)] transition-colors hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
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
        <div className="border-b border-[var(--color-line)] bg-[var(--color-bg-2)]/50 px-3 py-1.5">
          <details className="text-xs text-[var(--color-fg-mute)]">
            <summary className="cursor-pointer select-none hover:text-[var(--color-fg-soft)]">
              Context injected
            </summary>
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-eyebrow">
              {session.contextSummary}
            </pre>
          </details>
        </div>
      )}

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto p-4">
        {session.messages.length === 0 && !isActive && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-accent)]/10">
              <svg
                className="h-6 w-6 text-[var(--color-accent)]"
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
            <p className="text-sm text-[var(--color-fg-soft)]">
              Chat scoped to {scopeLabel(session.scope).toLowerCase()}
            </p>
            <p className="mt-1 text-xs text-[var(--color-fg-mute)]">
              Type a message and press Enter to begin
            </p>
          </div>
        )}

        <div className="flex flex-col gap-3">
          {turns.map((turn, i) => renderTurn(turn, `${turn.kind}-${i}`))}
          {isWaiting && <ThinkingIndicator />}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input area */}
      <div className="border-t border-[var(--color-line)] bg-[var(--color-bg-1)] p-3">
        <ChatInput
          ref={inputRef}
          value={inputValue}
          onChange={setInputValue}
          onSubmit={isActive ? handleSend : handleStartSession}
          canSubmit={isActive || inputValue.trim().length > 0}
          placeholder={isActive ? "Type a message..." : "Type a message to start..."}
          buttonTitle={isActive ? "Send message" : "Start session"}
          buttonAriaLabel={isActive ? "Send message" : "Start session"}
        />
      </div>
    </div>
  );
}
