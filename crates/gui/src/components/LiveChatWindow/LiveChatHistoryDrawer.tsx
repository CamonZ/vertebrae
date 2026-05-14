import { useCallback, useState } from "react";
import type { ChatSession } from "../../bindings";
import { useLiveChatStore } from "../../stores/liveChatStore";
import { formatRelative } from "../../utils/formatRelative";

interface Props {
  open: boolean;
  onClose: () => void;
}

const MAX_TITLE_LENGTH = 60;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

function sessionTimestamp(session: ChatSession): string | null {
  return (
    session.updated_at ?? session.inserted_at ?? session.started_at ?? null
  );
}

function sessionTitle(
  _session: ChatSession,
  isActive: boolean,
  activeMessages: { role: string; content: string }[]
): string {
  // We don't eagerly fetch messages for every history row; we can only show a
  // real title for the currently-loaded session. Everything else falls back to
  // a neutral label so the row is still recognizable.
  if (isActive) {
    const firstUser = activeMessages.find((m) => m.role === "user");
    if (firstUser && firstUser.content.trim()) {
      return truncate(firstUser.content.trim(), MAX_TITLE_LENGTH);
    }
  }
  return "Untitled session";
}

export function LiveChatHistoryDrawer({ open, onClose }: Props) {
  const sessions = useLiveChatStore((s) => s.sessions);
  const currentSession = useLiveChatStore((s) => s.currentSession);
  const messages = useLiveChatStore((s) => s.messages);
  const loadingSessions = useLiveChatStore((s) => s.loadingSessions);
  const deletingSessionId = useLiveChatStore((s) => s.deletingSessionId);
  const selectSession = useLiveChatStore((s) => s.selectSession);
  const deleteSession = useLiveChatStore((s) => s.deleteSession);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const handleSelect = useCallback(
    (id: string) => {
      if (currentSession?.id === id) {
        onClose();
        return;
      }
      void selectSession(id).then(() => onClose());
    },
    [currentSession, onClose, selectSession]
  );

  const handleConfirmDelete = useCallback(
    async (id: string) => {
      const ok = await deleteSession(id);
      if (ok) setConfirmDeleteId(null);
    },
    [deleteSession]
  );

  return (
    <>
      {/* Backdrop. Pointer events only when open so the underlying messages
          remain interactive in the resting state. */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className={`absolute inset-0 z-10 bg-black/30 transition-opacity duration-150 ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      <aside
        data-testid="live-chat-history-drawer"
        aria-label="Chat history"
        aria-hidden={!open}
        className={`absolute inset-y-0 left-0 z-20 flex w-full max-w-[20rem] flex-col border-r border-border bg-bg-primary shadow-xl transition-transform duration-150 ease-out ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <header className="sticky top-0 flex items-center justify-between border-b border-border bg-bg-primary px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
            Past chats
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close chat history"
            className="rounded p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
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
        </header>

        <div className="flex-1 overflow-y-auto">
          {loadingSessions && sessions.length === 0 && (
            <div className="px-3 py-4 text-xs text-text-muted">Loading…</div>
          )}

          {!loadingSessions && sessions.length === 0 && (
            <div className="px-3 py-4 text-xs text-text-muted">
              No past chats yet.
            </div>
          )}

          <ul role="list" className="divide-y divide-border/60">
            {sessions.map((session) => {
              const isActive = currentSession?.id === session.id;
              const isConfirming = confirmDeleteId === session.id;
              const isDeleting = deletingSessionId === session.id;
              const title = sessionTitle(session, isActive, messages);
              const stamp = formatRelative(sessionTimestamp(session));

              if (isConfirming) {
                return (
                  <li
                    key={session.id}
                    data-testid={`history-row-${session.id}`}
                    className="flex items-center justify-between gap-2 px-3 py-2"
                  >
                    <span className="truncate text-xs text-text-secondary">
                      Delete this chat?
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => void handleConfirmDelete(session.id)}
                        disabled={isDeleting}
                        aria-label={`Confirm delete chat ${session.id}`}
                        className="rounded border border-error/50 px-2 py-1 text-[11px] text-error transition-colors hover:bg-error/10 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        disabled={isDeleting}
                        aria-label={`Cancel delete chat ${session.id}`}
                        className="rounded border border-border px-2 py-1 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </span>
                  </li>
                );
              }

              return (
                <li
                  key={session.id}
                  data-testid={`history-row-${session.id}`}
                  className={`group flex items-center justify-between gap-2 px-3 py-2 transition-colors hover:bg-bg-hover ${
                    isActive ? "bg-primary/10" : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => handleSelect(session.id)}
                    className="flex min-w-0 flex-1 flex-col items-start text-left"
                    aria-label={`Open chat ${title}`}
                    aria-current={isActive ? "true" : undefined}
                  >
                    <span
                      className={`truncate text-xs ${
                        isActive
                          ? "font-medium text-text-primary"
                          : "text-text-primary"
                      }`}
                    >
                      {title}
                    </span>
                    {stamp && (
                      <span className="mt-0.5 text-[10px] text-text-muted">
                        {stamp}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(session.id)}
                    aria-label={`Delete chat ${session.id}`}
                    className="shrink-0 rounded p-1 text-text-muted opacity-0 transition-opacity hover:bg-bg-hover hover:text-error focus:opacity-100 group-hover:opacity-100"
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
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7V4h6v3m-8 0h10"
                      />
                    </svg>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </aside>
    </>
  );
}
