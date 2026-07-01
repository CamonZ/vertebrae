import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ChatSession } from "../../stores/chatStore";
import type { LocalChatSessionGroup } from "../../utils/localChatSessionGroups";
import {
  buildSpawnOutline,
  formatSessionModel,
  scrollToSpawn,
} from "./sessionListUtils";
import { SessionGroupList } from "./SessionGroupList";
import { SessionDeleteButton } from "./SessionDeleteButton";

interface LocalChatMiniPanelProps {
  activeSessionId: string;
  activeSession: ChatSession | null;
  deletingSessionId: string | null;
  deleteError: string | null;
  projectWarning: string | null;
  sessionGroups: LocalChatSessionGroup[];
  onStartFresh: () => void | Promise<void>;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void | Promise<void>;
}

/**
 * Compact session-list column shown alongside split panes in maximized mode.
 * Owns its own keyboard navigation (up/down/home/end/enter) over the flattened
 * session list. Active session's spawned-agent outline is rendered inline.
 */
export function LocalChatMiniPanel({
  activeSessionId,
  activeSession,
  deletingSessionId,
  deleteError,
  projectWarning,
  sessionGroups,
  onStartFresh,
  onSelect,
  onDelete,
}: LocalChatMiniPanelProps) {
  const sessionItems = useMemo(
    () => sessionGroups.flatMap((group) => group.sessions),
    [sessionGroups]
  );
  const sessionButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [keyboardSessionId, setKeyboardSessionId] = useState<string | null>(
    activeSessionId
  );
  const activeSpawnOutline = useMemo(
    () => buildSpawnOutline(activeSession?.messages ?? []),
    [activeSession?.messages]
  );

  useEffect(() => {
    if (sessionItems.length === 0) {
      setKeyboardSessionId(null);
      return;
    }
    if (sessionItems.some((session) => session.id === keyboardSessionId)) {
      return;
    }
    const activeSession = sessionItems.find(
      (session) => session.id === activeSessionId
    );
    setKeyboardSessionId(activeSession?.id ?? sessionItems[0].id);
  }, [activeSessionId, keyboardSessionId, sessionItems]);

  const focusHistorySession = useCallback((sessionId: string) => {
    setKeyboardSessionId(sessionId);
    sessionButtonRefs.current.get(sessionId)?.focus();
  }, []);

  const handleHistoryKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (sessionItems.length === 0) return;
      const currentIndex = Math.max(
        0,
        sessionItems.findIndex((session) => session.id === keyboardSessionId)
      );
      let nextIndex: number | null = null;

      if (event.key === "ArrowDown") {
        nextIndex = Math.min(sessionItems.length - 1, currentIndex + 1);
      } else if (event.key === "ArrowUp") {
        nextIndex = Math.max(0, currentIndex - 1);
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = sessionItems.length - 1;
      }

      if (nextIndex !== null) {
        event.preventDefault();
        focusHistorySession(sessionItems[nextIndex].id);
        return;
      }

      if (event.key !== "Enter" && event.key !== " ") return;
      if ((event.target as HTMLElement).closest("[data-mini-delete]")) return;
      event.preventDefault();
      const selectedSessionId =
        keyboardSessionId ??
        sessionItems.find((session) => session.id === activeSessionId)?.id ??
        sessionItems[0].id;
      onSelect(selectedSessionId);
    },
    [
      activeSessionId,
      focusHistorySession,
      keyboardSessionId,
      onSelect,
      sessionItems,
    ]
  );

  return (
    <aside
      data-testid="local-chat-mini-panel"
      aria-label="Local chat threads for active pane"
      className="hc-mini-history"
      tabIndex={-1}
      onKeyDown={handleHistoryKeyDown}
    >
      <div className="hc-mini-history-head">
        <span>Chats</span>
        <button
          type="button"
          className="hc-ctrl"
          onClick={() => void onStartFresh()}
          title="Start fresh local chat from history"
          aria-label="Start fresh local chat"
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
      </div>
      <div data-testid="local-chat-history-drawer">
        {deleteError && (
          <div role="alert" className="hc-mini-history-error">
            {deleteError}
          </div>
        )}
        {projectWarning && (
          <div role="alert" className="hc-mini-history-error">
            {projectWarning}
          </div>
        )}
        {sessionGroups.length === 0 ? (
          <div className="hc-mini-history-empty">No local chats yet.</div>
        ) : (
          <div className="hc-mini-history-list">
          <SessionGroupList
            sessionGroups={sessionGroups}
            activeSessionId={activeSessionId}
            deletingSessionId={deletingSessionId}
            renderGroup={(group, rows) => (
              <section
                key={group.id}
                className="hc-mini-history-group"
                aria-label={`${group.label} chats`}
              >
                <h3 className="hc-mini-history-group-title">{group.label}</h3>
                {rows}
              </section>
            )}
            renderRow={(session, { isActive, isDeleting }) => {
              const modelLabel = formatSessionModel(session);
              return (
                <div
                  className="hc-mini-history-row"
                  data-active={isActive || undefined}
                  data-keyboard-active={
                    keyboardSessionId === session.id || undefined
                  }
                >
                  <button
                    type="button"
                    className="hc-mini-history-open"
                    ref={(node) => {
                      if (node) {
                        sessionButtonRefs.current.set(session.id, node);
                      } else {
                        sessionButtonRefs.current.delete(session.id);
                      }
                    }}
                    onFocus={() => setKeyboardSessionId(session.id)}
                    onClick={() => onSelect(session.id)}
                    title={`Open local chat ${session.label}`}
                    aria-label={`Load local chat ${session.label} into active pane`}
                    aria-current={isActive ? "true" : undefined}
                  >
                    <span className="label">{session.label}</span>
                    <span className="preview">{session.preview}</span>
                    <span className="meta">{modelLabel}</span>
                  </button>
                  <SessionDeleteButton
                    label={session.label}
                    disabled={isDeleting}
                    onClick={() => void onDelete(session.id)}
                    dataMiniDelete
                  />
                  {isActive && activeSpawnOutline.length > 0 && (
                    <div className="hc-mini-history-children">
                      {activeSpawnOutline.map((spawn) => (
                        <button
                          key={spawn.id}
                          type="button"
                          className="hc-mini-history-child"
                          onClick={() =>
                            scrollToSpawn(session.id, spawn.spawnId)
                          }
                          title={`Jump to spawned agent ${spawn.label}`}
                          aria-label={`Jump to spawned agent ${spawn.label}`}
                        >
                          <span className="label">{spawn.label}</span>
                          <span className="meta">{spawn.detail}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            }}
          />
          </div>
        )}
      </div>
    </aside>
  );
}
