/**
 * The chat workspace tab strip (ticket 736f94f3, decision 49d12c2c §4): one
 * ARIA tablist over the open chats with roving tabindex and automatic
 * activation, a "+N" overflow menu, the "N need you" counter and a
 * fresh-chat button. The compact panel shows a title switcher
 * instead of tabs. Every control names its shortcut in its tooltip.
 */
import {
  useEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  CHAT_ATTENTION,
  chatAttentionText,
  type ChatAttentionState,
} from "../../utils/chatAttention";
import { Tooltip, type TooltipPlacement } from "../atoms/Tooltip";
import { OverflowMenu } from "../molecules/OverflowMenu";
import { SvgIcon } from "./ChatHeader";
import {
  CHAT_HISTORY_SHORTCUT,
  WORKSPACE_SHORTCUTS,
  shortcutTooltip,
} from "./chatShortcuts";
import {
  chatNumberHint,
  chatTabId,
  chatTabLabel,
  chatTabPanelId,
  chatTabTooltip,
  inlineTabs,
  type ChatTabModel,
} from "./chatTabs";
import {
  useTabCapacity,
  useTabDrag,
  useTabKeyboardFocus,
} from "./useChatTabStripInput";

/** States the live region announces; running and idle stay quiet. */
const ANNOUNCED: ReadonlySet<ChatAttentionState> = new Set([
  "blocked",
  "needs-you",
  "error",
  "your-turn",
]);

interface Announcement {
  text: string;
  /** Distinct per announcement, so repeating the same text is re-read. */
  key: number;
}

/** Announces chats that start needing the user, once per transition. */
function useAttentionAnnouncement(
  tabs: readonly ChatTabModel[]
): Announcement | null {
  const previous = useRef<Map<string, ChatAttentionState> | null>(null);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  useEffect(() => {
    const seen = previous.current;
    previous.current = new Map(
      tabs.map((tab) => [tab.id, tab.attention.state])
    );
    // First render and newly opened chats are not transitions.
    if (!seen) return;
    const changed = tabs.find(
      (tab) =>
        seen.has(tab.id) &&
        seen.get(tab.id) !== tab.attention.state &&
        ANNOUNCED.has(tab.attention.state)
    );
    if (!changed) return;
    const text = `${changed.title}: ${chatAttentionText(changed.attention)}`;
    setAnnouncement((current) => ({ text, key: (current?.key ?? 0) + 1 }));
  }, [tabs]);
  return announcement;
}

function TabDot({ tab }: { tab: ChatTabModel }) {
  // The tab's accessible name carries the state; the dot is decoration.
  const { tone } = CHAT_ATTENTION[tab.attention.state];
  if (!tone) return <span className="hc-tab-dot-slot" aria-hidden="true" />;
  return (
    <span
      className="chat-attention-dot"
      data-tone={tone}
      data-attention={tab.attention.state}
      data-testid="chat-tab-dot"
      aria-hidden="true"
    />
  );
}

function StripButton({
  label,
  tooltip,
  onClick,
  pressed,
  testId,
  className = "hc-ctrl",
  placement = "bottom",
  children,
}: {
  label: string;
  tooltip: string;
  /** The panel's right-edge controls open their tooltip to the left. */
  placement?: TooltipPlacement;
  onClick: () => void;
  pressed?: boolean;
  testId?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip label={tooltip} placement={placement}>
      <button
        type="button"
        className={className}
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
        data-testid={testId}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function PlusIcon() {
  return (
    <SvgIcon size="h-3.5 w-3.5">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 5v14m7-7H5"
      />
    </SvgIcon>
  );
}

function CloseIcon() {
  return (
    <SvgIcon size="h-3 w-3">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M6 18L18 6M6 6l12 12"
      />
    </SvgIcon>
  );
}

function HistoryIcon() {
  return (
    <SvgIcon size="h-3.5 w-3.5">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 6h16M4 12h16M4 18h10"
      />
    </SvgIcon>
  );
}

function ExpandIcon({ expanded }: { expanded: boolean }) {
  return (
    <SvgIcon size="h-3.5 w-3.5">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d={
          expanded
            ? "M9 9H4V4m0 5 5-5m6 5h5V4m0 5-5-5M9 15H4v5m0-5 5 5m6-5h5v5m0-5-5 5"
            : "M4 9V4h5M4 4l6 6m10-1V4h-5m5 0-6 6M4 15v5h5m-5 0 6-6m10 1v5h-5m5 0-6-6"
        }
      />
    </SvgIcon>
  );
}

export interface ChatTabStripProps {
  /** Every open chat in strip order. */
  tabs: readonly ChatTabModel[];
  activeId: string | null;
  /** Whether the workspace is expanded; compact shows a title switcher. */
  expanded: boolean;
  /** Open chats needing the user, in jump order. */
  needingYou: readonly string[];
  historyVisible: boolean;
  /** Selects a chat without moving focus (tab keys, clicks keep the tab). */
  onSelect: (id: string) => void;
  /** Selects a chat and moves the keyboard into its composer. */
  onEnterChat: (id: string) => void;
  onClose: (id: string) => void;
  /** Move `id` in front of `beforeId`, or to the end when null. */
  onMoveBefore: (id: string, beforeId: string | null) => void;
  onFreshChat: () => void;
  onToggleExpanded: () => void;
  onToggleHistory: () => void;
  onNextNeedingYou: () => void;
}

function ChevronDownIcon() {
  return (
    <SvgIcon size="h-3 w-3">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="m6 9 6 6 6-6"
      />
    </SvgIcon>
  );
}

interface ChatTabProps {
  tab: ChatTabModel;
  selected: boolean;
  /** "⌘⌥N" hint for the tooltip, when the tab has a number. */
  hint: string | null;
  showProject: boolean;
  closable: boolean;
  /** The only open chat: its title already heads the pane, so it is not a tab stop. */
  single: boolean;
  dropMarker: ReturnType<ReturnType<typeof useTabDrag>["dropMarker"]>;
  registerTab: (node: HTMLButtonElement | null) => void;
  onPointerDown: (event: ReactPointerEvent) => void;
  onClick: () => void;
  onKeyDown: (event: ReactKeyboardEvent) => void;
  onFocus: () => void;
  onBlur: (event: ReactFocusEvent) => void;
  onClose: () => void;
}

/** One inline tab: the ARIA tab button plus its close button. */
function ChatTab({
  tab,
  selected,
  hint,
  showProject,
  closable,
  single,
  dropMarker,
  registerTab,
  onPointerDown,
  onClick,
  onKeyDown,
  onFocus,
  onBlur,
  onClose,
}: ChatTabProps) {
  return (
    <div
      className="hc-tab"
      data-active={selected || undefined}
      {...dropMarker}
      data-testid="chat-tab-item"
    >
      <Tooltip
        label={chatTabTooltip(tab, hint)}
        placement="bottom"
        className="hc-tab-tip"
      >
        <button
          ref={registerTab}
          type="button"
          role="tab"
          id={chatTabId(tab.id)}
          aria-selected={selected}
          aria-controls={selected ? chatTabPanelId(tab.id) : undefined}
          aria-label={chatTabLabel(tab)}
          tabIndex={selected && !single ? 0 : -1}
          className="hc-tab-button"
          data-testid="chat-tab"
          data-entry-id={tab.id}
          onPointerDown={onPointerDown}
          onClick={onClick}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onBlur={onBlur}
        >
          <TabDot tab={tab} />
          {tab.isRun && <span className="hc-tab-kind">run</span>}
          <span className="hc-tab-title">{tab.title}</span>
          {showProject && tab.project && (
            <span className="hc-tab-project">{tab.project}</span>
          )}
        </button>
      </Tooltip>
      {closable && (
        <Tooltip
          label={shortcutTooltip("Close chat", WORKSPACE_SHORTCUTS.closeChat)}
          placement="bottom"
          className="inline-flex shrink-0"
        >
          <button
            type="button"
            tabIndex={-1}
            className="hc-tab-close"
            aria-label={`Close ${tab.title}`}
            data-testid="chat-tab-close"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

/** The "+N" menu of tabs that do not fit, with a dot when any needs you. */
function OverflowTabs({
  overflow,
  needingYouIds,
  showProject,
  onEnterChat,
}: {
  overflow: readonly ChatTabModel[];
  needingYouIds: ReadonlySet<string>;
  showProject: boolean;
  onEnterChat: (id: string) => void;
}) {
  if (overflow.length === 0) return null;
  const needYou = overflow.filter((tab) => needingYouIds.has(tab.id)).length;
  const chats = overflow.length === 1 ? "chat" : "chats";
  return (
    <OverflowMenu
      label={`${overflow.length} more open ${chats}${
        needYou > 0 ? `, ${needYou} need you` : ""
      }`}
      triggerTitle="More open chats"
      triggerClassName="hc-tabs-overflow"
      testId="chat-tabs-overflow"
      trigger={
        <>
          {needYou > 0 && (
            <span
              className="chat-attention-dot"
              data-tone="accent"
              data-testid="chat-tabs-overflow-dot"
              aria-hidden
            />
          )}
          +{overflow.length}
        </>
      }
      items={overflow.map((tab) => ({
        key: tab.id,
        label:
          showProject && tab.project
            ? `${tab.title} · ${tab.project}`
            : tab.title,
        ariaLabel: chatTabLabel(tab),
        icon: <TabDot tab={tab} />,
        onSelect: () => onEnterChat(tab.id),
        testId: "chat-tabs-overflow-item",
      }))}
    />
  );
}

/** The compact panel's title switcher in place of tabs. */
function CompactSwitcher({
  tabs,
  activeId,
  onEnterChat,
}: {
  tabs: readonly ChatTabModel[];
  activeId: string | null;
  onEnterChat: (id: string) => void;
}) {
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
  if (!active || tabs.length <= 1) {
    return <span className="hc-tabs-spacer" />;
  }
  return (
    <OverflowMenu
      label={`Switch chat: ${chatTabLabel(active)}`}
      triggerTitle={shortcutTooltip(
        "Switch chat",
        WORKSPACE_SHORTCUTS.nextChat
      )}
      triggerClassName="hc-tabs-switcher"
      testId="chat-tabs-switcher"
      trigger={
        <>
          <TabDot tab={active} />
          {/* The pane header right below already shows (and renames) this
              title; the trigger keeps the dot, count and its accessible name. */}
          <span className="hc-tabs-count">{tabs.length}</span>
          <ChevronDownIcon />
        </>
      }
      items={tabs.map((tab) => ({
        key: tab.id,
        label: tab.title,
        ariaLabel: chatTabLabel(tab),
        checked: tab.id === active.id,
        icon: <TabDot tab={tab} />,
        onSelect: () => onEnterChat(tab.id),
        testId: "chat-tabs-switcher-item",
      }))}
    />
  );
}

/** Right-edge controls shared by both layouts, plus the live region. */
function StripControls({
  announcement,
  expanded,
  needingYou,
  historyVisible,
  onToggleExpanded,
  onToggleHistory,
  onNextNeedingYou,
}: { announcement: Announcement | null } & Pick<
  ChatTabStripProps,
  | "expanded"
  | "needingYou"
  | "historyVisible"
  | "onToggleExpanded"
  | "onToggleHistory"
  | "onNextNeedingYou"
>) {
  const expandLabel = expanded
    ? "Collapse chat workspace"
    : "Expand chat workspace";
  const count = needingYou.length;
  return (
    <>
      {count > 0 && (
        <StripButton
          label={`${count} ${count === 1 ? "chat needs" : "chats need"} you; go to the next`}
          tooltip={shortcutTooltip(
            "Next chat needing you",
            WORKSPACE_SHORTCUTS.nextNeedingYou
          )}
          onClick={onNextNeedingYou}
          className="hc-tabs-counter"
          testId="chat-tabs-need-you"
        >
          <span className="chat-attention-dot" data-tone="accent" aria-hidden />
          {count} need you
        </StripButton>
      )}
      {/* The compact panel has one chrome row: its history and expand
          controls live in the pane header's overflow menu instead. */}
      {expanded && (
        <>
          <StripButton
            label="Chat history"
            tooltip={shortcutTooltip("Chat history", CHAT_HISTORY_SHORTCUT)}
            onClick={onToggleHistory}
            pressed={historyVisible}
            testId="chat-tabs-history"
            placement="left"
          >
            <HistoryIcon />
          </StripButton>
          <StripButton
            label={expandLabel}
            tooltip={shortcutTooltip(
              expandLabel,
              WORKSPACE_SHORTCUTS.toggleExpanded
            )}
            onClick={onToggleExpanded}
            testId="chat-tabs-expand"
            placement="left"
          >
            <ExpandIcon expanded={expanded} />
          </StripButton>
        </>
      )}
      <span className="sr-only" aria-live="polite" data-testid="chat-tabs-live">
        {announcement && (
          <span key={announcement.key}>{announcement.text}</span>
        )}
      </span>
    </>
  );
}

export function ChatTabStrip(props: ChatTabStripProps) {
  // Lives here, not in StripControls, so switching layouts keeps the history.
  const announcement = useAttentionAnnouncement(props.tabs);
  const controls = <StripControls announcement={announcement} {...props} />;
  if (!props.expanded) {
    // Nothing to switch or answer: the row collapses to zero height.
    const idle = props.tabs.length <= 1 && props.needingYou.length === 0;
    return (
      <div
        className="hc-tabs"
        data-compact=""
        data-empty={idle ? "" : undefined}
        data-testid="chat-tab-strip"
      >
        <CompactSwitcher
          tabs={props.tabs}
          activeId={props.activeId}
          onEnterChat={props.onEnterChat}
        />
        <span className="hc-tabs-fill" />
        {controls}
      </div>
    );
  }
  return (
    <div className="hc-tabs" data-testid="chat-tab-strip">
      <ExpandedTabs {...props} />
      {controls}
    </div>
  );
}

/** The expanded strip's tablist, "+N" menu and new-chat button. */
function ExpandedTabs({
  tabs,
  activeId,
  needingYou,
  onSelect,
  onEnterChat,
  onClose,
  onMoveBefore,
  onFreshChat,
}: ChatTabStripProps) {
  const showProject =
    new Set(tabs.flatMap((tab) => (tab.project ? [tab.project] : []))).size > 1;
  const { tabAreaRef, capacity } = useTabCapacity(tabs.length);
  const shown = inlineTabs(tabs, activeId, capacity);
  const shownIds = new Set(shown.map((tab) => tab.id));
  const overflow = tabs.filter((tab) => !shownIds.has(tab.id));

  const tablistRef = useRef<HTMLDivElement>(null);
  const focus = useTabKeyboardFocus({
    tabs,
    tablistRef,
    onSelect,
    onEnterChat,
    onClose,
  });
  const drag = useTabDrag({
    shown,
    overflow,
    tabCount: tabs.length,
    tabRefs: focus.tabRefs,
    onMoveBefore,
  });

  return (
    <div className="hc-tabs-main" ref={tabAreaRef}>
      <div
        ref={tablistRef}
        role="tablist"
        aria-label="Open chats"
        aria-orientation="horizontal"
        className="hc-tablist"
        data-single={tabs.length === 1 ? "" : undefined}
        {...drag.tablistHandlers}
      >
        {shown.map((tab) => (
          <ChatTab
            key={tab.id}
            tab={tab}
            selected={tab.id === activeId}
            hint={chatNumberHint(tabs.indexOf(tab), tabs.length)}
            showProject={showProject}
            closable={tabs.length > 1}
            single={tabs.length === 1}
            dropMarker={drag.dropMarker(tab.id)}
            registerTab={focus.registerTab(tab.id)}
            onPointerDown={(event) => drag.onTabPointerDown(event, tab.id)}
            onClick={() => focus.enterChat(tab.id)}
            onKeyDown={(event) => focus.onTabKeyDown(event, tab.id)}
            onFocus={() => focus.onTabFocus(tab.id)}
            onBlur={focus.onTabBlur}
            onClose={() => onClose(tab.id)}
          />
        ))}
      </div>
      <OverflowTabs
        overflow={overflow}
        needingYouIds={new Set(needingYou)}
        showProject={showProject}
        onEnterChat={onEnterChat}
      />
      <StripButton
        label="New chat"
        tooltip={shortcutTooltip("New chat", WORKSPACE_SHORTCUTS.freshChat)}
        onClick={onFreshChat}
        testId="chat-tabs-new"
      >
        <PlusIcon />
      </StripButton>
    </div>
  );
}
