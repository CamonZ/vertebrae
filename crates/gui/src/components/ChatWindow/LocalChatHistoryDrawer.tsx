import type { LocalChatSessionGroup } from "../../utils/localChatSessionGroups";
import { formatSessionTime } from "./sessionListUtils";
import { SessionGroupList } from "./SessionGroupList";
import { SessionDeleteButton } from "./SessionDeleteButton";

interface LocalChatHistoryDrawerProps {
  activeSessionId: string;
  deletingSessionId: string | null;
  deleteError: string | null;
  projectWarning: string | null;
  sessionGroups: LocalChatSessionGroup[];
  onClose: () => void;
  onStartFresh: () => void | Promise<void>;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void | Promise<void>;
}

/**
 * Full-coverage drawer overlay shown over the single-pane (non-maximized)
 * chat. Renders the project-grouped local chat history with card-style rows
 * and a close button in the header.
 */
export function LocalChatHistoryDrawer({
  activeSessionId,
  deletingSessionId,
  deleteError,
  projectWarning,
  sessionGroups,
  onClose,
  onStartFresh,
  onSelect,
  onDelete,
}: LocalChatHistoryDrawerProps) {
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
            onClick={() => void onStartFresh()}
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
      {projectWarning && (
        <div
          role="alert"
          className="border-b border-[var(--color-line)] bg-[var(--warn-wash)] px-3 py-2 text-xs text-[var(--warn)]"
        >
          {projectWarning}
        </div>
      )}
      {sessionGroups.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-[var(--color-fg-mute)]">
          No local chats yet.
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-2">
          <SessionGroupList
            sessionGroups={sessionGroups}
            activeSessionId={activeSessionId}
            deletingSessionId={deletingSessionId}
            renderGroup={(group, rows) => (
              <section
                key={group.id}
                className="mb-3 last:mb-0"
                aria-label={`${group.label} chats`}
              >
                <h3 className="px-1 pb-2 text-[10px] font-medium text-[var(--color-fg-mute)] uppercase">
                  {group.label}
                </h3>
                {rows}
              </section>
            )}
            renderRow={(session, { isActive, isDeleting }) => {
              const formattedTime = formatSessionTime(session.updatedAt);
              return (
                <div
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
                        {session.providerResumeId && (
                          <span className="shrink-0 rounded border border-[var(--color-line)] px-1.5 py-0.5 text-[10px] text-[var(--color-fg-mute)] uppercase">
                            resumable
                          </span>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-[var(--color-fg-soft)]">
                        {session.preview}
                      </p>
                      <p className="mt-1 text-[10px] text-[var(--color-fg-mute)] uppercase">
                        Chat · {session.messageCount} messages
                        {formattedTime ? ` · ${formattedTime}` : ""}
                      </p>
                    </button>
                    <SessionDeleteButton
                      label={session.label}
                      disabled={isDeleting}
                      onClick={() => void onDelete(session.id)}
                    />
                  </div>
                </div>
              );
            }}
          />
        </div>
      )}
    </aside>
  );
}
