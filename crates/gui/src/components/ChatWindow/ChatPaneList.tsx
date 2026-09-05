import { memo, useCallback } from "react";
import { useChatStore } from "../../stores/chatStore";
import type { ChatPane } from "../../stores/chatStore";
import { ChatWindow } from "./ChatWindow";

interface ChatPaneListProps {
  visiblePanes: ChatPane[];
  activePaneId: string | null;
  isMaximized: boolean;
  canAddSplitPane: boolean;
  focusPane: (paneId: string) => void;
  closePane: (paneId: string) => void;
  unsplitPanes: (paneId?: string) => void;
  closeChatPanel: () => void;
  toggleHistorySelector: () => boolean;
  toggleMaximized: () => void;
  startFreshActiveSession: (paneId: string) => Promise<boolean>;
  splitWithFreshSession: () => Promise<boolean>;
  projectLabelBySessionId?: ReadonlyMap<string, string>;
  renderObserver?: (paneId: string, part: "transcript" | "composer") => void;
}

/**
 * Renders the visible chat panes side-by-side (maximized) or as a single pane.
 * Each pane wraps a ChatWindow in a focusable section that drives pane
 * selection on interaction.
 */
export const ChatPaneList = memo(function ChatPaneList({
  visiblePanes,
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
  projectLabelBySessionId,
  renderObserver,
}: ChatPaneListProps) {
  const paneCount = visiblePanes.length;

  return (
    <div className="hc-chat-panes">
      {visiblePanes.map((pane, index) => {
        const paneIsActive = pane.id === activePaneId;
        return (
          <ChatPaneWindow
            key={pane.id}
            pane={pane}
            paneIsActive={paneIsActive}
            paneCount={paneCount}
            sessionId={pane.sessionId}
            index={index}
            focusPane={focusPane}
            closePane={closePane}
            closeChatPanel={closeChatPanel}
            toggleHistorySelector={toggleHistorySelector}
            toggleMaximized={toggleMaximized}
            startFreshActiveSession={startFreshActiveSession}
            splitWithFreshSession={splitWithFreshSession}
            isMaximized={isMaximized}
            canAddSplitPane={canAddSplitPane}
            unsplitPanes={unsplitPanes}
            projectLabelBySessionId={projectLabelBySessionId}
            renderObserver={renderObserver}
          />
        );
      })}
    </div>
  );
});

interface ChatPaneWindowProps {
  pane: ChatPane;
  paneIsActive: boolean;
  paneCount: number;
  index: number;
  sessionId: string;
  isMaximized: boolean;
  canAddSplitPane: boolean;
  closePane: (paneId: string) => void;
  unsplitPanes: (paneId?: string) => void;
  closeChatPanel: () => void;
  toggleHistorySelector: () => boolean;
  toggleMaximized: () => void;
  startFreshActiveSession: (paneId: string) => Promise<boolean>;
  splitWithFreshSession: () => Promise<boolean>;
  projectLabelBySessionId?: ReadonlyMap<string, string>;
  focusPane: (paneId: string) => void;
  renderObserver?: (paneId: string, part: "transcript" | "composer") => void;
}

const ChatPaneWindow = memo(function ChatPaneWindow({
  pane,
  paneIsActive,
  paneCount,
  index,
  sessionId,
  isMaximized,
  canAddSplitPane,
  closePane,
  unsplitPanes,
  closeChatPanel,
  toggleHistorySelector,
  toggleMaximized,
  startFreshActiveSession,
  splitWithFreshSession,
  projectLabelBySessionId,
  focusPane,
  renderObserver,
}: ChatPaneWindowProps) {
  const session = useChatStore((state) => state.sessions[sessionId]);
  const onStartFresh = useCallback(
    () => void startFreshActiveSession(pane.id),
    [pane.id, startFreshActiveSession]
  );
  const onSplitPane = useCallback(
    () => void splitWithFreshSession(),
    [splitWithFreshSession]
  );
  const onUnsplitPanes = useCallback(
    () => unsplitPanes(pane.id),
    [pane.id, unsplitPanes]
  );
  const onClosePane = useCallback(
    () => closePane(pane.id),
    [closePane, pane.id]
  );

  if (!session) return null;
  return (
    <section
      className="hc-chat-pane"
      data-testid="chat-pane"
      data-pane-active={paneIsActive || undefined}
      aria-label={`Chat pane ${index + 1}: ${session.title?.trim() || session.label}`}
      aria-selected={paneIsActive}
      tabIndex={0}
      onMouseDownCapture={(event) => {
        focusPane(pane.id);
        const target = event.target as HTMLElement;
        if (
          target.closest(
            "button, input, select, textarea, a, [contenteditable='true']"
          )
        )
          return;
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
        key={session.id}
        sessionId={session.id}
        onClosePanel={closeChatPanel}
        onStartFresh={onStartFresh}
        onToggleHistory={toggleHistorySelector}
        onToggleWide={toggleMaximized}
        isWide={isMaximized}
        onSplitPane={isMaximized ? onSplitPane : undefined}
        canSplitPane={canAddSplitPane}
        onUnsplitPanes={
          isMaximized && paneCount > 1 ? onUnsplitPanes : undefined
        }
        onClosePane={isMaximized && paneCount > 1 ? onClosePane : undefined}
        autoFocusComposer={!isMaximized || paneIsActive}
        projectLabel={projectLabelBySessionId?.get(session.id)}
        renderObserver={(part) => renderObserver?.(pane.id, part)}
      />
    </section>
  );
});
