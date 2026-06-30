import type { ChatPane, ChatSession } from "../../stores/chatStore";
import { ChatWindow } from "./ChatWindow";
import { DetachedPlaceholder } from "./DetachedPlaceholder";

interface ChatPaneListProps {
  visiblePanes: ChatPane[];
  sessions: Record<string, ChatSession>;
  activePaneId: string | null;
  isMaximized: boolean;
  canAddSplitPane: boolean;
  focusPane: (paneId: string) => void;
  closePane: (paneId: string) => void;
  unsplitPanes: (paneId?: string) => void;
  reattachSession: (sessionId: string) => void;
  closeChatPanel: () => void;
  toggleMaximized: () => void;
  startFreshActiveSession: () => Promise<boolean>;
  splitWithFreshSession: () => Promise<boolean>;
}

/**
 * Renders the visible chat panes side-by-side (maximized) or as a single pane.
 * Each pane wraps a ChatWindow (or DetachedPlaceholder) in a focusable section
 * that drives pane selection on interaction.
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
  reattachSession,
  closeChatPanel,
  toggleMaximized,
  startFreshActiveSession,
  splitWithFreshSession,
}: ChatPaneListProps) {
  const paneCount = visiblePanes.length;

  return (
    <div className="hc-chat-panes">
      {visiblePanes.map((pane, index) => {
        const session = sessions[pane.sessionId];
        if (!session) return null;
        const paneIsActive = pane.id === activePaneId;
        return (
          <section
            key={pane.id}
            className="hc-chat-pane"
            data-testid="chat-pane"
            data-pane-active={paneIsActive || undefined}
            aria-label={`Chat pane ${index + 1}: ${session.label}`}
            aria-selected={paneIsActive}
            tabIndex={0}
            onMouseDownCapture={() => focusPane(pane.id)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              focusPane(pane.id);
            }}
          >
            {session.isDetached ? (
              <DetachedPlaceholder
                label={session.label}
                onReattach={() => reattachSession(session.id)}
              />
            ) : (
              <ChatWindow
                key={`${pane.id}:${session.id}`}
                sessionId={session.id}
                onClosePanel={closeChatPanel}
                onStartFresh={() => void startFreshActiveSession()}
                onToggleWide={toggleMaximized}
                isWide={isMaximized}
                onSplitPane={
                  isMaximized
                    ? () => void splitWithFreshSession()
                    : undefined
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
              />
            )}
          </section>
        );
      })}
    </div>
  );
}
