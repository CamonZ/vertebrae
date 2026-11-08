import {
  Fragment,
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useId,
} from "react";
import { useChatStore } from "../../stores/chatStore";
import type { ChatPane } from "../../stores/chatStore";
import { ChatWindow } from "./ChatWindow";
import {
  allocatePaneWidths,
  resizePanePair,
  type PaneWidths,
} from "./chatPaneWidths";
import { ChatPaneResizeHandle } from "./ChatPaneResizeHandle";

export type RegisterChangesToggle = (
  paneId: string,
  toggle: (() => void) | null
) => void;

interface ChatPaneListProps {
  registerChangesToggle?: RegisterChangesToggle;
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
  registerChangesToggle,
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
  const containerRef = useRef<HTMLDivElement>(null);
  const domId = useId();

  const paneCount = visiblePanes.length;
  const ids = visiblePanes.map((pane) => pane.id);
  const split = isMaximized && paneCount > 1;
  const configuration = split ? JSON.stringify(ids) : "single";

  const [allocation, setAllocation] = useState<{
    configuration: string;
    preferred: PaneWidths;
  }>({ configuration, preferred: {} });
  const [containerWidth, setContainerWidth] = useState(0);

  // A new split configuration starts equal; session/title/focus changes retain it.
  if (allocation.configuration !== configuration) {
    setAllocation({ configuration, preferred: {} });
  }

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => setContainerWidth(container.clientWidth);
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(container);

    return () => observer.disconnect();
  }, []);

  const preferred =
    allocation.configuration === configuration ? allocation.preferred : {};
  const widths = allocatePaneWidths(ids, containerWidth, preferred);
  const layoutKey = `${configuration}:${containerWidth}`;

  return (
    <div className="hc-chat-panes" ref={containerRef}>
      {visiblePanes.map((pane, index) => {
        const paneIsActive = pane.id === activePaneId;
        const paneWidth = widths[pane.id];
        const paneStyle = split ? { flex: `0 0 ${paneWidth}px` } : undefined;

        const previousIndex = index - 1;
        const previousPaneId = ids[previousIndex];
        const leftWidth = widths[previousPaneId];
        const separatorLabel = `Resize chat panes ${index} and ${index + 1}`;
        const separatorControls = `${domId}-${previousIndex} ${domId}-${index}`;

        const resizePair = (delta: number) => {
          const nextPreferred = resizePanePair(
            widths,
            previousPaneId,
            pane.id,
            delta
          );

          if (nextPreferred !== widths) {
            setAllocation({ configuration, preferred: nextPreferred });
          }
        };

        return (
          <Fragment key={pane.id}>
            {split && index > 0 && (
              <ChatPaneResizeHandle
                label={separatorLabel}
                controls={separatorControls}
                leftWidth={leftWidth}
                rightWidth={paneWidth}
                layoutKey={layoutKey}
                onResize={resizePair}
              />
            )}
            <div
              className="hc-chat-pane-slot"
              id={`${domId}-${index}`}
              data-pane-id={pane.id}
              style={paneStyle}
            >
              <ChatPaneWindow
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
                registerChangesToggle={registerChangesToggle}
              />
            </div>
          </Fragment>
        );
      })}
    </div>
  );
});

interface ChatPaneWindowProps {
  registerChangesToggle?: RegisterChangesToggle;
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
  registerChangesToggle,
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
  // Only the label is read here; selecting the session object would re-render
  // the pane on every live text batch.
  const label = useChatStore((state) => {
    const session = state.sessions[sessionId];
    return session ? session.title?.trim() || session.label : undefined;
  });
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

  const registerToggle = useCallback(
    (toggle: (() => void) | null) => registerChangesToggle?.(pane.id, toggle),
    [pane.id, registerChangesToggle]
  );

  if (label === undefined) return null;
  return (
    <section
      className="hc-chat-pane"
      data-testid="chat-pane"
      data-pane-active={paneIsActive || undefined}
      aria-label={`Chat pane ${index + 1}: ${label}`}
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
        key={sessionId}
        sessionId={sessionId}
        registerChangesToggle={registerToggle}
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
        showProjectContext={paneCount > 1}
        projectLabel={projectLabelBySessionId?.get(sessionId)}
        renderObserver={(part) => renderObserver?.(pane.id, part)}
      />
    </section>
  );
});
