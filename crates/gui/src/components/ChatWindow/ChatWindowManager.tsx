import { useEffect, useRef, useState } from "react";
import { useChatStore } from "../../stores/chatStore";
import type { LocalChatSessionSummary } from "../../utils/localChatPersistence";
import { scopeLabel } from "../../utils/chatContext";
import { useGlassPanel } from "../../hooks/useGlassPanel";
import { usePanelExitTransition } from "../../hooks/usePanelExitTransition";
import { doCloseSession } from "../../hooks/useScopedChat";
import { ChatWindow } from "./ChatWindow";

/** Floating chat-panel width: persistence key and clamp bounds (px). Mirrors
 * the task-detail panel's horizontal resize (TaskDetailPanel.tsx). */
const WIDTH_STORAGE_KEY = "chat-window-manager-width";
const MIN_PANEL_WIDTH = 320;
const MAX_PANEL_WIDTH = 760;
const DEFAULT_PANEL_WIDTH = 384;
/** Keyboard resize step (px) for the drag handle. */
const RESIZE_STEP = 16;
/** Exit-animation duration (ms). Must match `.hc-panel.is-closing` (--t-base). */
const EXIT_MS = 180;

/**
 * ChatWindowManager manages multiple chat session tabs in a floating-glass side
 * panel anchored bottom-left (design reference `.hc-panel`, opened by the
 * FloatingChatLauncher pill). Renders the active session's ChatWindow, which
 * owns the single header band (title + scope) and the composer.
 */
export function ChatWindowManager() {
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const panelOpen = useChatStore((s) => s.panelOpen);
  const togglePanel = useChatStore((s) => s.togglePanel);
  const reattachSession = useChatStore((s) => s.reattachSession);
  const listLocalSessions = useChatStore((s) => s.listLocalSessions);
  const selectPersistedSession = useChatStore((s) => s.selectPersistedSession);
  const deleteLocalSession = useChatStore((s) => s.deleteLocalSession);
  const startFreshSession = useChatStore((s) => s.startFreshSession);
  const markSessionClosed = useChatStore((s) => s.markSessionClosed);
  const setSessionLifecycle = useChatStore((s) => s.setSessionLifecycle);
  const setClaudeSessionId = useChatStore((s) => s.setClaudeSessionId);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(
    null
  );
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Horizontal resize. The panel is left-anchored, so a drag on its right edge
  // widens it as the cursor moves right. We measure the panel's fixed left edge
  // from the DOM rather than assuming the inset value.
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_PANEL_WIDTH;
    const stored = parseInt(localStorage.getItem(WIDTH_STORAGE_KEY) ?? "", 10);
    return Number.isNaN(stored)
      ? DEFAULT_PANEL_WIDTH
      : Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, stored));
  });
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(WIDTH_STORAGE_KEY, String(panelWidth));
    }
  }, [panelWidth]);

  useEffect(() => {
    if (!isResizing) return;
    const onMove = (event: MouseEvent) => {
      const leftEdge = panelRef.current?.getBoundingClientRect().left ?? 0;
      setPanelWidth(
        Math.min(
          MAX_PANEL_WIDTH,
          Math.max(MIN_PANEL_WIDTH, event.clientX - leftEdge)
        )
      );
    };
    const onUp = () => setIsResizing(false);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "ew-resize";
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizing]);

  const sessionList = Object.values(sessions);
  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const activeProjectPath = activeSession?.projectPath;
  const localSessionSummaries = listLocalSessions(activeProjectPath);

  const open = panelOpen && sessionList.length > 0;
  const startFreshActiveSession = () => {
    if (!activeSession) return;
    const label = `New ${scopeLabel(activeSession.scope)} Chat`;
    startFreshSession(
      activeSession.scope,
      activeSession.entityId,
      label,
      activeProjectPath
    );
    setHistoryOpen(false);
  };

  // Join the shared glass-panel focus model so Escape closes whichever panel is
  // focused. The chat is globally mounted; it's "open" only while showing.
  const { isFocused, focusProps } = useGlassPanel({
    id: "chat",
    isOpen: open,
    onClose: togglePanel,
  });

  // Defer unmount so the panel can drill back out to the edge on close. Sessions
  // persist in the store through the close, so content stays put while it exits.
  const { mounted, closing, onAnimationEnd } = usePanelExitTransition(
    open,
    EXIT_MS
  );

  if (!mounted) {
    return null;
  }

  return (
    <div
      ref={panelRef}
      className={`hc-panel${closing ? " is-closing" : ""}`}
      style={{ width: `${panelWidth}px` }}
      data-testid="chat-window-manager"
      data-focused={isFocused || undefined}
      data-closing={closing || undefined}
      onAnimationEnd={onAnimationEnd}
      {...focusProps}
    >
      {/* Right-edge drag handle for horizontal resize */}
      <div
        className="hc-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        aria-valuenow={panelWidth}
        aria-valuemin={MIN_PANEL_WIDTH}
        aria-valuemax={MAX_PANEL_WIDTH}
        tabIndex={0}
        data-resizing={isResizing || undefined}
        data-testid="chat-resize-handle"
        onMouseDown={(event) => {
          event.preventDefault();
          setIsResizing(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            setPanelWidth((w) => Math.min(MAX_PANEL_WIDTH, w + RESIZE_STEP));
          } else if (event.key === "ArrowLeft") {
            setPanelWidth((w) => Math.max(MIN_PANEL_WIDTH, w - RESIZE_STEP));
          }
        }}
      />
      {/* Active chat window — owns the single header band, message thread, and
          composer. A detached session shows a reattach placeholder instead so we
          don't double-render its history into a pop-out. */}
      {activeSession?.isDetached && (
        <DetachedPlaceholder
          label={activeSession.label}
          onReattach={() => reattachSession(activeSession.id)}
        />
      )}
      {activeSession && !activeSession.isDetached && (
        <ChatWindow
          sessionId={activeSession.id}
          onClosePanel={togglePanel}
          onToggleHistory={() => setHistoryOpen((value) => !value)}
          onStartFresh={startFreshActiveSession}
        />
      )}
      {historyOpen && activeSession && (
        <LocalChatHistoryDrawer
          activeSessionId={activeSession.id}
          sessions={localSessionSummaries}
          onClose={() => setHistoryOpen(false)}
          onStartFresh={startFreshActiveSession}
          onSelect={(sessionId) => {
            setDeleteError(null);
            if (selectPersistedSession(sessionId)) {
              setHistoryOpen(false);
            }
          }}
          deletingSessionId={deletingSessionId}
          deleteError={deleteError}
          onDelete={async (sessionId) => {
            setDeleteError(null);
            const target = useChatStore.getState().sessions[sessionId];
            if (target?.claudeSessionId) {
              setDeletingSessionId(sessionId);
              const closed = await doCloseSession(
                target.claudeSessionId,
                sessionId,
                {
                  markSessionClosed,
                  setSessionLifecycle,
                  setClaudeSessionId,
                  setClaudeSessionIdRef: () => {},
                }
              );
              setDeletingSessionId(null);
              if (!closed) {
                setDeleteError("Could not delete local chat. Try again.");
                return;
              }
            }
            const wasActive =
              sessionId === useChatStore.getState().activeSessionId;
            deleteLocalSession(sessionId);
            if (wasActive) {
              setHistoryOpen(false);
            }
          }}
        />
      )}
    </div>
  );
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function LocalChatHistoryDrawer({
  activeSessionId,
  deletingSessionId,
  deleteError,
  sessions,
  onClose,
  onStartFresh,
  onSelect,
  onDelete,
}: {
  activeSessionId: string;
  deletingSessionId: string | null;
  deleteError: string | null;
  sessions: LocalChatSessionSummary[];
  onClose: () => void;
  onStartFresh: () => void;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void | Promise<void>;
}) {
  return (
    <aside
      data-testid="local-chat-history-drawer"
      aria-label="Local chat history"
      className="absolute inset-0 z-20 flex flex-col overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] shadow-xl"
    >
      <div className="flex items-center justify-between border-b border-[var(--color-line)] px-3 py-2">
        <h2 className="text-sm font-medium text-[var(--color-fg)]">
          Local chats
        </h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="hc-ctrl"
            onClick={onStartFresh}
            title="Start fresh local chat from history"
            aria-label="Start fresh local chat from history"
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
                d="M12 5v14m7-7H5"
              />
            </svg>
          </button>
          <button
            type="button"
            className="hc-ctrl"
            onClick={onClose}
            title="Close chat history"
            aria-label="Close chat history"
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
      </div>
      {deleteError && (
        <div
          role="alert"
          className="border-b border-[var(--color-line)] bg-[var(--err-wash)] px-3 py-2 text-xs text-[var(--err)]"
        >
          {deleteError}
        </div>
      )}
      {sessions.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-[var(--color-fg-mute)]">
          No local chats yet.
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-2">
          {sessions.map((session) => {
            const isActive = session.id === activeSessionId;
            const isDeleting = session.id === deletingSessionId;
            const formattedTime = formatSessionTime(session.updatedAt);
            return (
              <div
                key={session.id}
                className={`group mb-2 rounded-md border p-2 ${
                  isActive
                    ? "border-[var(--accent)] bg-[var(--color-bg-2)]"
                    : "border-[var(--color-line)] bg-[var(--color-bg-1)]"
                }`}
                data-active={isActive || undefined}
              >
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => onSelect(session.id)}
                    title={`Open local chat ${session.label}`}
                    aria-label={`Open local chat ${session.label}`}
                    aria-current={isActive ? "true" : undefined}
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-[var(--color-fg)]">
                        {session.label}
                      </span>
                      {session.claudeConversationId && (
                        <span className="shrink-0 rounded border border-[var(--color-line)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--color-fg-mute)]">
                          resumable
                        </span>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-[var(--color-fg-soft)]">
                      {session.preview}
                    </p>
                    <p className="mt-1 text-[10px] uppercase text-[var(--color-fg-mute)]">
                      {scopeLabel(session.scope)} · {session.messageCount}{" "}
                      messages
                      {formattedTime ? ` · ${formattedTime}` : ""}
                    </p>
                  </button>
                  <button
                    type="button"
                    className="hc-ctrl danger shrink-0"
                    disabled={isDeleting}
                    onClick={() => void onDelete(session.id)}
                    title={`Delete local chat ${session.label}`}
                    aria-label={`Delete local chat ${session.label}`}
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
            );
          })}
        </div>
      )}
    </aside>
  );
}

/**
 * Placeholder shown in the main panel when the active tab's session has
 * been detached into a pop-out window. Offers a one-click reattach.
 */
function DetachedPlaceholder({
  label,
  onReattach,
}: {
  label: string;
  onReattach: () => void;
}) {
  return (
    <div
      role="status"
      aria-label="Session detached"
      className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <span className="rounded-full bg-[var(--color-accent)]/10 p-3 text-[var(--color-accent)]">
        <svg
          className="h-6 w-6"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M14 5h5v5M19 5l-7 7M5 5h4v2H7v10h10v-2h2v4H5z"
          />
        </svg>
      </span>
      <p className="text-sm text-[var(--color-fg-soft)]">
        <span className="font-medium text-[var(--color-fg)]">{label}</span> is
        open in a pop-out window
      </p>
      <button
        onClick={onReattach}
        className="rounded-md border border-[var(--color-line)] bg-[var(--color-bg-1)] px-3 py-1.5 text-xs text-[var(--color-fg)] transition-colors hover:bg-[var(--color-bg-3)]"
      >
        Reattach to panel
      </button>
    </div>
  );
}
