import {
  memo,
  type ComponentPropsWithoutRef,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";
import { isRunPane, useChatStore } from "../../stores/chatStore";
import type { ChatPane, LocalChatPane } from "../../stores/chatStore";
import type { SideSection } from "../../stores/chatSideColumnStore";
import { RunPaneWindow } from "./run/RunChatPane";
import { ChatWindow } from "./ChatWindow";
import { chatTabId, chatTabPanelId } from "./chatTabs";
import {
  chatFocusAreaOf,
  saveChatFocusArea,
} from "../../stores/chatViewMemory";

/** What ⌘⇧B and ⌘⇧[ ] do to a chat's side column; false when nothing. */
export interface SideColumnControls {
  toggle(): boolean;
  /** Show `section`, or close the column showing it; false if unavailable. */
  toggleSection(section: SideSection): boolean;
  /**
   * Close the column when it expanded the chat, returning to the compact
   * chat; false when it did not.
   */
  leaveExpanded(): boolean;
}

export type RegisterSideColumn = (
  paneId: string,
  controls: SideColumnControls | null
) => void;

export type RegisterPaneFind = (
  paneId: string,
  openFind: (() => boolean) | null
) => void;

interface ChatPaneListProps {
  registerSideColumn?: RegisterSideColumn;
  registerPaneFind?: RegisterPaneFind;
  /** The active tab's chat; null before any chat opens. */
  shownPane: ChatPane | null;
  /** The strip is a tablist: the slot is the tabpanel of the active tab. */
  tabPanels: boolean;
  focusPane: (paneId: string) => void;
  closeChatPanel: () => void;
  startFreshActiveSession: (paneId: string) => Promise<boolean>;
  /** Visible chats span projects: name each pane's project in its header. */
  showProjectContext: boolean;
  projectLabelBySessionId?: ReadonlyMap<string, string>;
  renderObserver?: (paneId: string, part: "transcript" | "composer") => void;
}

/**
 * Renders the shown chat (the active tab). Hidden chats unmount; their
 * drafts, scroll and focus are restored on return.
 */
export const ChatPaneList = memo(function ChatPaneList({
  registerSideColumn,
  registerPaneFind,
  shownPane: pane,
  tabPanels,
  focusPane,
  closeChatPanel,
  startFreshActiveSession,
  showProjectContext,
  projectLabelBySessionId,
  renderObserver,
}: ChatPaneListProps) {
  return (
    // Focus parks here while a focused chat unmounts (see ChatPaneSlot).
    <div className="hc-chat-panes" tabIndex={-1} data-focus-halo="none">
      {pane && (
        <ChatPaneSlot
          key={pane.id}
          id={tabPanels ? chatTabPanelId(pane.id) : undefined}
          role={tabPanels ? "tabpanel" : undefined}
          aria-labelledby={tabPanels ? chatTabId(pane.id) : undefined}
          data-pane-id={pane.id}
        >
          {isRunPane(pane) ? (
            <RunPaneWindow
              pane={pane}
              focusPane={focusPane}
              closeChatPanel={closeChatPanel}
              registerFind={registerPaneFind}
            />
          ) : (
            <ChatPaneWindow
              pane={pane}
              sessionId={pane.sessionId}
              focusPane={focusPane}
              closeChatPanel={closeChatPanel}
              startFreshActiveSession={startFreshActiveSession}
              showProjectContext={showProjectContext}
              projectLabelBySessionId={projectLabelBySessionId}
              renderObserver={renderObserver}
              registerSideColumn={registerSideColumn}
              registerPaneFind={registerPaneFind}
            />
          )}
        </ChatPaneSlot>
      )}
    </div>
  );
});

/**
 * A visible chat's slot. When it unmounts holding focus (its tab was left),
 * focus moves to the pane list first: WebKit stops delivering typing to an
 * input focused by script after the focused element was removed, so focus
 * must never fall through to the body on the way to the next chat.
 */
function ChatPaneSlot(props: ComponentPropsWithoutRef<"div">) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    return () => {
      if (!slot?.contains(document.activeElement)) return;
      slot
        .closest<HTMLElement>(".hc-chat-panes")
        ?.focus({ preventScroll: true });
    };
  }, []);
  return <div {...props} ref={ref} className="hc-chat-pane-slot" />;
}

interface ChatPaneWindowProps {
  registerSideColumn?: RegisterSideColumn;
  registerPaneFind?: RegisterPaneFind;
  pane: LocalChatPane;
  sessionId: string;
  closeChatPanel: () => void;
  startFreshActiveSession: (paneId: string) => Promise<boolean>;
  showProjectContext: boolean;
  projectLabelBySessionId?: ReadonlyMap<string, string>;
  focusPane: (paneId: string) => void;
  renderObserver?: (paneId: string, part: "transcript" | "composer") => void;
}

const ChatPaneWindow = memo(function ChatPaneWindow({
  registerSideColumn,
  registerPaneFind,
  pane,
  sessionId,
  closeChatPanel,
  startFreshActiveSession,
  showProjectContext,
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
  // The shown chat takes a pending composer focus request, once.
  const composerFocusRevision = useChatStore((state) =>
    state.panelOpen &&
    state.composerFocusRevision > state.composerFocusHandledRevision
      ? state.composerFocusRevision
      : null
  );
  const onStartFresh = useCallback(
    () => void startFreshActiveSession(pane.id),
    [pane.id, startFreshActiveSession]
  );
  const registerColumn = useCallback(
    (controls: SideColumnControls | null) =>
      registerSideColumn?.(pane.id, controls),
    [pane.id, registerSideColumn]
  );
  const registerFind = useCallback(
    (openFind: (() => boolean) | null) => registerPaneFind?.(pane.id, openFind),
    [pane.id, registerPaneFind]
  );

  if (label === undefined) return null;
  return (
    <section
      className="hc-chat-pane"
      data-testid="chat-pane"
      aria-label={label}
      tabIndex={0}
      onFocusCapture={(event) => {
        const area = chatFocusAreaOf(event.target);
        if (area) saveChatFocusArea(sessionId, area);
      }}
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
        registerSideColumn={registerColumn}
        registerFind={registerFind}
        onClosePanel={closeChatPanel}
        onStartFresh={onStartFresh}
        composerFocusRevision={composerFocusRevision}
        showProjectContext={showProjectContext}
        projectLabel={projectLabelBySessionId?.get(sessionId)}
        renderObserver={(part) => renderObserver?.(pane.id, part)}
      />
    </section>
  );
});
