import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveChatStore } from "../../stores/liveChatStore";
import { MarkdownContent } from "../shared/MarkdownContent";

export function LiveChatWindow() {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastMessageCountRef = useRef(0);
  const [inputValue, setInputValue] = useState("");

  const session = useLiveChatStore((s) => s.currentSession);
  const messages = useLiveChatStore((s) => s.messages);
  const sending = useLiveChatStore((s) => s.sending);
  const creatingSession = useLiveChatStore((s) => s.creatingSession);
  const lastError = useLiveChatStore((s) => s.lastError);
  const sendMessage = useLiveChatStore((s) => s.sendMessage);
  const togglePanel = useLiveChatStore((s) => s.togglePanel);
  const hydrate = useLiveChatStore((s) => s.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (messages.length > lastMessageCountRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    lastMessageCountRef.current = messages.length;
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const sendDisabled =
    !inputValue.trim() || sending || creatingSession;

  const handleSend = useCallback(async () => {
    if (sendDisabled) return;
    const trimmed = inputValue.trim();
    setInputValue("");
    await sendMessage(trimmed);
  }, [inputValue, sendDisabled, sendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend]
  );

  return (
    <div
      data-testid="live-chat-window"
      className="flex h-full flex-col"
      aria-label="Sacrum live chat"
    >
      <div className="flex items-center justify-between border-b border-border bg-bg-primary px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-primary">
            Live
          </span>
          <span className="text-text-secondary">
            {session ? `Session ${session.id.slice(0, 8)}` : "No session yet"}
          </span>
        </div>
        <button
          onClick={togglePanel}
          className="rounded p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          title="Close live chat"
          aria-label="Close live chat"
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
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <p className="text-sm text-text-secondary">
              Start a sacrum live chat for this project
            </p>
            <p className="mt-1 text-xs text-text-muted">
              Type a message and press Enter to begin
            </p>
          </div>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            data-testid={`live-chat-message-${message.role}`}
            className={`max-w-[85%] rounded-lg px-4 py-3 ${
              message.role === "user"
                ? "self-end bg-primary/20"
                : "self-start bg-bg-tertiary"
            } ${message.error ? "border border-error/40" : ""}`}
          >
            <MarkdownContent text={message.content} />
            <div className="mt-2 flex items-center justify-end gap-2 text-[11px] text-text-muted">
              {message.pending && <span>sending…</span>}
              {message.error && (
                <span className="text-error">{message.error}</span>
              )}
              <span>{new Date(message.createdAt).toLocaleTimeString()}</span>
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {lastError && (
        <div className="border-t border-error/30 bg-error/10 px-3 py-1.5 text-xs text-error">
          {lastError}
        </div>
      )}

      <div className="flex gap-2 border-t border-border bg-bg-secondary p-3">
        <textarea
          ref={inputRef}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          aria-label="Message"
          disabled={sending || creatingSession}
          className="flex-1 resize-none rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
          rows={2}
        />
        <button
          onClick={() => void handleSend()}
          disabled={sendDisabled}
          aria-label="Send message"
          className="flex h-auto items-center justify-center rounded-lg bg-primary px-3 text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
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
  );
}
