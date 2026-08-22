import type { ReactNode } from "react";
import type { ChatPane, ChatSession } from "../../stores/chatStore";
import { ChatWindow } from "./ChatWindow";

interface ChatPaneListProps {
  visiblePanes: ChatPane[];
  sessions: Record<string, ChatSession>;
  activePaneId: string | null;
  isMaximized: boolean;
  canAddSplitPane: boolean;
  focusPane: (paneId: string) => void;
  closePane: (paneId: string) => void;
  unsplitPanes: (paneId?: string) => void;
  closeChatPanel: () => void;
  toggleHistorySelector: () => boolean;
  toggleMaximized: () => void;
  startFreshActiveSession: () => Promise<boolean>;
  splitWithFreshSession: () => Promise<boolean>;
  emptyStateNotice?: ReactNode;
  emptyStateNoticeProjectPath?: string | null;
  projectLabelBySessionId?: ReadonlyMap<string, string>;
}

/**
 * Renders the visible chat panes side-by-side (maximized) or as a single pane.
 * Each pane wraps a ChatWindow in a focusable section that drives pane
 * selection on interaction.
 */
export function ChatPaneList({
  visiblePanes,
  sessions,
  activePaneId,
  isMaximized,
  canAddSplitPane,
  focusPane,
  closePane,
  unsplitPanes,
  closeChatPanel,
  toggleHistorySelector,
  toggleMaximized,
  startFreshActiveSession,
  splitWithFreshSession,
  emptyStateNotice,
  emptyStateNoticeProjectPath,
  projectLabelBySessionId,
}: ChatPaneListProps) {
  const paneCount = visiblePanes.length;

  return (
    <div className="hc-chat-panes">
      {visiblePanes.map((pane, index) => {
        const session = sessions[pane.sessionId];
        if (!session) return null;
        const paneIsActive = pane.id === activePaneId;
        const paneNotice =
          emptyStateNotice &&
          session.resumeNoticeDismissed !== true &&
          (session.projectPath ?? null) ===
            (emptyStateNoticeProjectPath ?? null)
            ? emptyStateNotice
            : undefined;
        return (
          <section
            key={pane.id}
            className="hc-chat-pane"
            data-testid="chat-pane"
            data-pane-active={paneIsActive || undefined}
            aria-label={`Chat pane ${index + 1}: ${session.label}`}
            aria-selected={paneIsActive}
            tabIndex={0}
            onMouseDownCapture={(event) => {
              focusPane(pane.id);
              const target = event.target as HTMLElement;
              if (
                target.closest(
                  "button, input, select, textarea, a, [contenteditable='true']"
                )
              ) {
                return;
              }
              event.currentTarget
                .querySelector<HTMLTextAreaElement>(
                  '[data-testid="local-chat-composer"]'
                )
                ?.focus();
            }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              focusPane(pane.id);
            }}
          >
            <ChatWindow
              key={`${pane.id}:${session.id}`}
              sessionId={session.id}
              emptyStateNotice={paneNotice}
              onClosePanel={closeChatPanel}
              onStartFresh={() => void startFreshActiveSession()}
              onToggleHistory={() => {
                toggleHistorySelector();
              }}
              onToggleWide={toggleMaximized}
              isWide={isMaximized}
              onSplitPane={
                isMaximized ? () => void splitWithFreshSession() : undefined
              }
              canSplitPane={canAddSplitPane}
              onUnsplitPanes={
                isMaximized && paneCount > 1
                  ? () => unsplitPanes(pane.id)
                  : undefined
              }
              onClosePane={
                isMaximized && paneCount > 1
                  ? () => closePane(pane.id)
                  : undefined
              }
              autoFocusComposer={!isMaximized || paneIsActive}
              projectLabel={projectLabelBySessionId?.get(session.id)}
            />
          </section>
        );
      })}
    </div>
  );
}
