import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useLiveChatStore } from "../../stores/liveChatStore";
import { detachLiveChat } from "../../utils/detachLiveChat";
import { MarkdownContent } from "../shared/MarkdownContent";
import { ChatMessage } from "../molecules/ChatMessage";
import { LiveChatHistoryDrawer } from "./LiveChatHistoryDrawer";
import { ChatInput } from "../ChatInput";

interface LiveChatHeaderProps {
  standalone: boolean;
  hasLeavableState: boolean;
  onToggleHistory: () => void;
  onNewChat: () => void;
  onDetach: () => void;
  onClose: () => void;
}

function LiveChatHeader({
  standalone,
  hasLeavableState,
  onToggleHistory,
  onNewChat,
  onDetach,
  onClose,
}: LiveChatHeaderProps) {
  return (
    <div className="z-30 flex h-12 items-center gap-1 border-b border-[var(--color-line)] bg-[var(--color-bg)] px-3">
      <span className="shrink-0 rounded bg-[var(--color-accent)]/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[var(--color-accent)]">
        Live
      </span>
      <button
        type="button"
        onClick={onToggleHistory}
        aria-label="Toggle chat history"
        title="Toggle chat history"
        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-fg-soft)] transition-colors hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
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
            d="M4 6h16M4 12h16M4 18h16"
          />
        </svg>
        History
      </button>
      <button
        type="button"
        onClick={onNewChat}
        disabled={!hasLeavableState}
        aria-label="Start new chat"
        title="Start new chat"
        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-fg-soft)] transition-colors hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-[var(--color-fg-soft)]"
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
            d="M12 4v16m8-8H4"
          />
        </svg>
        New chat
      </button>
      <div className="flex-1" />
      {!standalone && (
        <button
          type="button"
          onClick={onDetach}
          aria-label="Detach live chat"
          title="Detach into own window"
          className="rounded p-1 text-[var(--color-fg-mute)] transition-colors hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
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
              d="M14 5h5v5M19 5l-7 7M5 19h5M5 19v-5M5 19l7-7"
            />
          </svg>
        </button>
      )}
      {!standalone && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close live chat"
          title="Close live chat"
          className="rounded p-1 text-[var(--color-fg-mute)] transition-colors hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
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
    </div>
  );
}

interface LiveChatWindowProps {
  standalone?: boolean;
}

export function LiveChatWindow({ standalone = false }: LiveChatWindowProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastMessageCountRef = useRef(0);
  const [inputValue, setInputValue] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);

  const session = useLiveChatStore((s) => s.currentSession);
  const messages = useLiveChatStore((s) => s.messages);
  const sending = useLiveChatStore((s) => s.sending);
  const creatingSession = useLiveChatStore((s) => s.creatingSession);
  const lastError = useLiveChatStore((s) => s.lastError);
  const resumableSessionId = useLiveChatStore((s) => s.resumableSessionId);
  const sendMessage = useLiveChatStore((s) => s.sendMessage);
  const togglePanel = useLiveChatStore((s) => s.togglePanel);
  const loadSessions = useLiveChatStore((s) => s.loadSessions);
  const loadResumableSessionId = useLiveChatStore(
    (s) => s.loadResumableSessionId
  );
  const selectSession = useLiveChatStore((s) => s.selectSession);
  const resumeLastSession = useLiveChatStore((s) => s.resumeLastSession);
  const newChat = useLiveChatStore((s) => s.newChat);

  // On panel/page open: load history list and probe for a resumable session.
  //
  // Embedded panel (`standalone=false`): we do NOT auto-select the resumable
  // session — the empty state surfaces a "Resume" link so the user can choose
  // between starting fresh and resuming.
  //
  // Standalone window (`standalone=true`): the user just detached an active
  // chat, so their intent is "continue the chat I detached". Auto-select the
  // cached active session — without this, `currentSession` stays null and
  // `applyRemoteMessage` silently drops incoming reply events (see ticket
  // 57de9a26). When there is no cached id we fall through to the empty state.
  useEffect(() => {
    void loadSessions();
    void (async () => {
      const id = await loadResumableSessionId();
      if (!standalone || !id) return;
      if (useLiveChatStore.getState().currentSession) return;
      await selectSession(id);
    })();
  }, [loadSessions, loadResumableSessionId, selectSession, standalone]);

  useEffect(() => {
    if (messages.length > lastMessageCountRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    lastMessageCountRef.current = messages.length;
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const sendDisabled = !inputValue.trim() || sending || creatingSession;

  const handleSend = useCallback(async () => {
    if (sendDisabled) return;
    const trimmed = inputValue.trim();
    setInputValue("");
    await sendMessage(trimmed);
  }, [inputValue, sendDisabled, sendMessage]);

  const handleNewChat = useCallback(() => {
    newChat();
    setHistoryOpen(false);
    inputRef.current?.focus();
  }, [newChat]);

  const handleClose = useCallback(() => {
    togglePanel();
  }, [togglePanel]);

  const handleDetach = useCallback(() => {
    void detachLiveChat();
  }, []);

  const handleStandaloneClose = useCallback(() => {
    // Standalone never renders the Close button, but keep the handler typed.
    void getCurrentWebviewWindow().close();
  }, []);

  const hasLeavableState = Boolean(session) || messages.length > 0;
  const showResumeLink = !session && messages.length === 0 && !!resumableSessionId;

  return (
    <div
      data-testid="live-chat-window"
      className="relative flex h-full flex-col overflow-hidden"
      aria-label="Live chat"
    >
      <LiveChatHeader
        standalone={standalone}
        hasLeavableState={hasLeavableState}
        onToggleHistory={() => setHistoryOpen((v) => !v)}
        onNewChat={handleNewChat}
        onDetach={handleDetach}
        onClose={standalone ? handleStandaloneClose : handleClose}
      />

      <div className="relative flex flex-1 flex-col overflow-hidden">
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
          {messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <p className="text-sm text-[var(--color-fg-soft)]">
                Start a live chat
              </p>
              <p className="mt-1 text-xs text-[var(--color-fg-mute)]">
                Type a message and press Enter to begin
              </p>
              {showResumeLink && (
                <button
                  type="button"
                  onClick={() => void resumeLastSession()}
                  aria-label="Resume last session"
                  className="mt-3 text-xs text-[var(--color-accent)] transition-colors hover:underline"
                >
                  Resume last session →
                </button>
              )}
            </div>
          )}

          {messages.map((message) => {
            const role = message.role === "user" ? "user" : "assistant";
            const author = role === "user" ? "YOU" : "CLAUDE";
            return (
              <div
                key={message.id}
                data-testid={`live-chat-message-${message.role}`}
                className={`flex ${role === "user" ? "justify-end" : "justify-start"}`}
              >
                <ChatMessage
                  role={role}
                  author={author}
                  timestamp={new Date(message.createdAt).toLocaleTimeString()}
                  streaming={message.pending}
                  className={
                    message.error
                      ? "ring-1 ring-[var(--color-err)]/40 rounded-[var(--radius-lg)]"
                      : undefined
                  }
                >
                  <MarkdownContent text={message.content} />
                  {(message.pending || message.error) && (
                    <div className="mt-2 flex items-center gap-2 text-[11px] text-[var(--color-fg-mute)]">
                      {message.pending && <span>sending…</span>}
                      {message.error && (
                        <span className="text-[var(--color-err)]">
                          {message.error}
                        </span>
                      )}
                    </div>
                  )}
                </ChatMessage>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        <LiveChatHistoryDrawer
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
        />
      </div>

      {lastError && (
        <div className="border-t border-[var(--color-err)]/30 bg-[var(--color-err)]/10 px-3 py-1.5 text-xs text-[var(--color-err)]">
          {lastError}
        </div>
      )}

      <div className="border-t border-[var(--color-line)] bg-[var(--color-bg-1)] p-3">
        <ChatInput
          ref={inputRef}
          value={inputValue}
          onChange={setInputValue}
          onSubmit={() => void handleSend()}
          disabled={sending || creatingSession}
          canSubmit={!sendDisabled}
          ariaLabel="Message"
        />
      </div>
    </div>
  );
}
