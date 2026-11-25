import {
  CHAT_AREA_SHORTCUT,
  CHAT_HISTORY_SHORTCUT,
  SIDE_COLUMN_SHORTCUTS,
  WORKSPACE_SHORTCUTS,
  shortcutText,
} from "./chatShortcuts";
import {
  SIDE_SECTION_LABEL,
  type SideSection,
} from "../../stores/chatSideColumnStore";
import { useDiscussionSummary } from "./selectionDiscussionState";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { WorkspaceChromeContext } from "./WorkspaceChromeContext";
import { StopIcon } from "../panels";
import { OverflowMenu } from "../molecules/OverflowMenu";
import { FALLBACK_CHAT_PROJECT_LABEL } from "../../utils/localChatSessionGroups";
import { CHAT_ATTENTION, type ChatAttention } from "../../utils/chatAttention";
import { ChatAttentionDot } from "./ChatAttentionDot";
import type { TaskLevel } from "../../bindings";
import type { LinkedPr } from "../../stores/prLinks";
import { IdChip } from "../shared/HearthPrimitives";
import { ChatHeaderPrChip } from "./GithubPr";
import type { PrCheckCounts } from "./workspace/prChecksView";

interface ChatHeaderProps {
  label: string;
  /** The chat's attention state: dot plus reason text. */
  attention: ChatAttention;
  isClosing: boolean;
  canStopGeneration: boolean;
  /** A turn is in flight; Stop shows only then. Defaults to canStopGeneration. */
  isGenerating?: boolean;
  onClosePanel?: () => void;
  onStartFresh?: () => void;
  /** The side column's shown section; null while it is closed. */
  sideSection?: SideSection | null;
  /** Show a section, or close the column when it is the one shown. */
  onToggleSection?: (section: SideSection) => void;
  /** The chat has a checkout, so Changes can open. */
  changesAvailable?: boolean;
  /** The chat has background work to list. */
  backgroundAvailable?: boolean;
  backgroundRunning?: number;
  onClearMessages: () => void;
  onStopGeneration: () => void;
  onTitleSave?: (title: string) => void | Promise<void>;
  onTitleRegenerate?: () => void;
  isTitleRegenerating?: boolean;
  titleError?: string | null;
  projectLabel?: string;
  showProjectContext?: boolean;
  /** The Vertebrae entity this chat is associated with. */
  entity?: { id: string; level: TaskLevel } | null;
  linkedPr?: LinkedPr | null;
  /** Check counts of the linked PR, from the same refresh as Changes. */
  linkedPrChecks?: PrCheckCounts | null;
  /** Unresolved GitHub review threads on the linked PR, once read. */
  linkedPrOpenThreads?: number | null;
  /** Shows the Changes panel from the PR chip; without it the chip is static. */
  onOpenPrInChanges?: () => void;
}

export interface HeaderAction {
  key: string;
  title: string;
  ariaLabel: string;
  onClick: () => void;
  show: boolean;
  disabled?: boolean;
  className?: string;
  testId?: string;
  pressed?: boolean;
  badge?: number;
  /** Something here needs attention (an error); drawn in the alert style. */
  alert?: boolean;
  icon: React.ReactNode;
  /** Render inside the pane's `⋯` overflow menu instead of inline. */
  menu?: boolean;
  /** Visible menu text; defaults to `title`. */
  menuLabel?: string;
  /** Draw a divider above this item in the overflow menu. */
  menuGroupStart?: boolean;
}

export function SvgIcon({
  size,
  className,
  children,
}: {
  size: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <svg
      className={[size, className].filter(Boolean).join(" ")}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      {children}
    </svg>
  );
}

const TOGGLE_KEYS = shortcutText(SIDE_COLUMN_SHORTCUTS.toggle);
const AREA_KEYS = shortcutText(CHAT_AREA_SHORTCUT);

interface PaneControlProps {
  onClosePanel?: () => void;
}

/**
 * The trailing panel control shared by local chat and run pane headers.
 * Layout, reveal and close-chat controls live on the tab strip (736f94f3).
 */
function buildPaneActions({ onClosePanel }: PaneControlProps): HeaderAction[] {
  return [
    {
      key: "closePanel",
      title: "Close chat panel",
      ariaLabel: "Close chat panel",
      onClick: onClosePanel!,
      show: !!onClosePanel,
      icon: (
        <SvgIcon size="h-4 w-4">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </SvgIcon>
      ),
    },
  ];
}

export function HeaderActionButtons({ actions }: { actions: HeaderAction[] }) {
  const shown = actions.filter((action) => action.show);
  const inline = shown.filter((action) => !action.menu);
  const menu = shown.filter((action) => action.menu);
  // The overflow trigger sits before the trailing close control so "close"
  // stays in the corner users expect.
  const trailing =
    inline.length > 0 && inline[inline.length - 1]?.key === "closePanel"
      ? inline.slice(-1)
      : [];
  const leading = trailing.length ? inline.slice(0, -1) : inline;
  const renderInline = (action: HeaderAction) => (
    <button
      key={action.key}
      className={`hc-ctrl${action.className ? ` ${action.className}` : ""}`}
      data-alert={action.alert ? "" : undefined}
      onClick={action.onClick}
      disabled={action.disabled}
      title={action.title}
      aria-label={action.ariaLabel}
      data-testid={action.testId}
      aria-pressed={action.pressed}
      aria-expanded={
        action.key === "changes" ||
        action.key === "discussions" ||
        action.key === "background"
          ? action.pressed
          : undefined
      }
    >
      {action.icon}
      {!!action.badge && (
        <span className="hc-ctrl-badge" aria-hidden>
          {action.badge}
        </span>
      )}
    </button>
  );
  return (
    <div className="hc-ctrls">
      {leading.map(renderInline)}
      {menu.length > 0 && (
        <OverflowMenu
          label="More pane actions"
          testId="pane-overflow-menu"
          items={menu.map((action) => ({
            key: action.key,
            label: action.menuLabel ?? action.title,
            ariaLabel: action.ariaLabel,
            title: action.title,
            onSelect: action.onClick,
            disabled: action.disabled,
            danger: action.className?.includes("danger"),
            pressed: action.pressed,
            badge: action.badge,
            icon: action.icon,
            testId: action.testId,
            separatorBefore: action.menuGroupStart,
          }))}
        />
      )}
      {trailing.map(renderInline)}
    </div>
  );
}

/** Header controls for non-chat panes: their own actions, then close panel. */
export function PaneControls({
  leading = [],
  ...props
}: PaneControlProps & { leading?: HeaderAction[] }) {
  return (
    <HeaderActionButtons actions={[...leading, ...buildPaneActions(props)]} />
  );
}

export function ChatHeader({
  label,
  attention,
  isClosing,
  canStopGeneration,
  isGenerating = canStopGeneration,
  onClosePanel,
  onStartFresh,
  sideSection = null,
  onToggleSection,
  changesAvailable = false,
  backgroundAvailable = false,
  backgroundRunning = 0,
  onClearMessages,
  onStopGeneration,
  onTitleSave,
  onTitleRegenerate,
  isTitleRegenerating = false,
  titleError,
  projectLabel = FALLBACK_CHAT_PROJECT_LABEL,
  showProjectContext = false,
  entity = null,
  linkedPr = null,
  linkedPrChecks = null,
  linkedPrOpenThreads = null,
  onOpenPrInChanges,
}: ChatHeaderProps) {
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState(label);
  const [titleEditError, setTitleEditError] = useState<string | null>(null);
  const [isSavingTitle, setIsSavingTitle] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleButtonRef = useRef<HTMLButtonElement>(null);
  /** Where focus was when renaming began; finishing returns it there. */
  const restoreTitleFocus = useRef<HTMLElement | "title" | null>(null);

  useEffect(() => {
    if (!isEditingTitle) setDraftTitle(label);
  }, [isEditingTitle, label]);

  useEffect(() => {
    if (isEditingTitle) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
      return;
    }
    const restore = restoreTitleFocus.current;
    restoreTitleFocus.current = null;
    if (restore instanceof HTMLElement && restore.isConnected) restore.focus();
    else if (restore) titleButtonRef.current?.focus();
  }, [isEditingTitle]);

  const beginTitleEdit = useCallback(() => {
    if (!onTitleSave || isTitleRegenerating || isSavingTitle) return;
    setDraftTitle(label);
    setTitleEditError(null);
    const previous = document.activeElement;
    restoreTitleFocus.current =
      previous instanceof HTMLElement && previous !== document.body
        ? previous
        : "title";
    setIsEditingTitle(true);
  }, [isSavingTitle, isTitleRegenerating, label, onTitleSave]);

  const cancelTitleEdit = useCallback(() => {
    setDraftTitle(label);
    setTitleEditError(null);
    restoreTitleFocus.current ??= "title";
    setIsEditingTitle(false);
  }, [label]);

  const saveTitle = useCallback(async () => {
    const normalized = draftTitle.replace(/\s+/g, " ").trim();
    if (!normalized) {
      setTitleEditError("Chat title cannot be empty.");
      return;
    }
    if (normalized === label) {
      cancelTitleEdit();
      return;
    }
    if (!onTitleSave) return;

    setIsSavingTitle(true);
    setTitleEditError(null);
    try {
      await onTitleSave(normalized);
      restoreTitleFocus.current ??= "title";
      setIsEditingTitle(false);
    } catch (error) {
      setTitleEditError(
        error instanceof Error ? error.message : "Failed to save chat title."
      );
    } finally {
      setIsSavingTitle(false);
    }
  }, [cancelTitleEdit, draftTitle, label, onTitleSave]);

  const handleTitleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelTitleEdit();
      } else if (event.key === "Enter") {
        event.preventDefault();
        void saveTitle();
      }
    },
    [cancelTitleEdit, saveTitle]
  );

  const paneActions = buildPaneActions({ onClosePanel });

  const discussions = useDiscussionSummary();
  const chrome = useContext(WorkspaceChromeContext);
  const columnOpen = sideSection !== null;
  /**
   * A side section's toggle. Toolbar rule (two to three visible actions):
   * visible while it is the shown section, when it needs attention, or
   * (column closed) when it has content; otherwise in the overflow menu.
   * With the column open its switcher reaches the other sections, except
   * that Discussions stays visible with content (db5160ff constraint 3).
   */
  const sectionAction = (
    section: SideSection,
    {
      show,
      count = 0,
      alert = false,
      ariaLabel,
      testId,
      icon,
      visibleWithContent = false,
    }: {
      show: boolean;
      /** Visible with content even while the column shows another section. */
      visibleWithContent?: boolean;
      count?: number;
      alert?: boolean;
      ariaLabel: string;
      testId: string;
      icon: React.ReactNode;
    }
  ): HeaderAction => {
    const pressed = sideSection === section;
    const label = SIDE_SECTION_LABEL[section];
    const keys = shortcutText(SIDE_COLUMN_SHORTCUTS[section]);
    return {
      key: section,
      title: pressed
        ? `Hide ${label} (${keys}) · ${CHAT_AREA_SHORTCUT.label} (${AREA_KEYS})`
        : `Show ${label} (${keys}) · ${TOGGLE_KEYS} side column`,
      ariaLabel,
      onClick: () => onToggleSection?.(section),
      show: show && !!onToggleSection,
      pressed,
      alert,
      menu:
        !pressed &&
        !alert &&
        (count === 0 || (columnOpen && !visibleWithContent)),
      menuLabel: label,
      badge: count,
      testId,
      icon,
    };
  };

  const actions: HeaderAction[] = [
    sectionAction("changes", {
      show: changesAvailable,
      ariaLabel: "Changes",
      testId: "local-chat-view-changes",
      icon: (
        <SvgIcon size="h-3.5 w-3.5">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M15 4v16M6 9h6M9 6v6M6 16h6" />
        </SvgIcon>
      ),
    }),
    sectionAction("discussions", {
      show: changesAvailable || discussions.count > 0 || discussions.alert,
      count: discussions.count,
      alert: discussions.alert,
      visibleWithContent: true,
      ariaLabel: [
        "Discussions",
        discussions.count > 0 ? `${discussions.count}` : null,
        discussions.alert ? "anchor error" : null,
      ]
        .filter(Boolean)
        .join(", "),
      testId: "local-chat-view-discussions",
      icon: (
        <SvgIcon size="h-3.5 w-3.5">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M7 8h10M7 12h6m-9 8 3.5-3H18a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v14Z"
          />
        </SvgIcon>
      ),
    }),
    sectionAction("background", {
      show: backgroundAvailable || sideSection === "background",
      count: backgroundRunning,
      ariaLabel:
        backgroundRunning > 0
          ? `Background tasks, ${backgroundRunning} running`
          : "Background tasks",
      testId: "local-chat-view-background",
      icon: (
        <SvgIcon size="h-3.5 w-3.5">
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v4l2.5 2.5" />
        </SvgIcon>
      ),
    }),
    {
      // The compact panel has no tab strip row, so its workspace controls
      // live here; the expanded workspace keeps them on its strip.
      key: "workspaceHistory",
      title: `Chat history (${shortcutText(CHAT_HISTORY_SHORTCUT)})`,
      ariaLabel: "Chat history",
      onClick: () => chrome?.onToggleHistory(),
      show: !!chrome && !chrome.expanded,
      menu: true,
      menuLabel: "Chat history",
      testId: "local-chat-workspace-history",
      icon: (
        <SvgIcon size="h-3.5 w-3.5">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 6h16M4 12h16M4 18h10"
          />
        </SvgIcon>
      ),
    },
    {
      key: "workspaceExpand",
      title: `Expand chat workspace (${shortcutText(WORKSPACE_SHORTCUTS.toggleExpanded)})`,
      ariaLabel: "Expand chat workspace",
      onClick: () => chrome?.onToggleExpanded(),
      show: !!chrome && !chrome.expanded,
      menu: true,
      menuLabel: "Expand chat workspace",
      testId: "local-chat-workspace-expand",
      icon: (
        <SvgIcon size="h-3.5 w-3.5">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 9V4h5M4 4l6 6m10-1V4h-5m5 0-6 6M4 15v5h5m-5 0 6-6m10 1v5h-5m5 0-6-6"
          />
        </SvgIcon>
      ),
    },
    {
      key: "fresh",
      title: "Start fresh local chat",
      ariaLabel: "Start fresh local chat",
      onClick: onStartFresh!,
      show: !!onStartFresh,
      menu: true,
      menuLabel: "New chat",
      icon: (
        <SvgIcon size="h-3.5 w-3.5">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 5v14m7-7H5"
          />
        </SvgIcon>
      ),
    },
    {
      key: "regenerateTitle",
      title: "Regenerate chat title",
      ariaLabel: isTitleRegenerating
        ? "Regenerating chat title"
        : "Regenerate chat title",
      onClick: onTitleRegenerate!,
      show: !!onTitleRegenerate,
      disabled: isTitleRegenerating || isSavingTitle,
      menu: true,
      menuLabel: "Regenerate title",
      menuGroupStart: true,
      testId: "local-chat-title-regenerate",
      icon: (
        <SvgIcon size="h-3.5 w-3.5">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 4v5h5M20 20v-5h-5M5.5 15a7 7 0 0011.8 1.2L20 15M4 9a7 7 0 0111.8-1.2L20 9"
          />
        </SvgIcon>
      ),
    },
    {
      key: "clear",
      title: "Clear messages",
      ariaLabel: "Clear messages",
      onClick: onClearMessages,
      show: true,
      disabled: isClosing,
      className: "danger",
      menu: true,
      menuGroupStart: true,
      icon: (
        <SvgIcon size="h-3.5 w-3.5">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
          />
        </SvgIcon>
      ),
    },
    {
      // Shown only while generating (UX-01); ⌘. and the palette reach it too.
      key: "stop",
      title: "Stop generation (⌘.)",
      ariaLabel: "Stop generation",
      onClick: onStopGeneration,
      show: isGenerating,
      disabled: !canStopGeneration,
      className: "danger hc-stop",
      testId: "local-chat-stop-generation",
      icon: (
        <>
          <StopIcon />
          <span className="hc-stop-label">Stop</span>
        </>
      ),
    },
    ...paneActions,
  ];

  return (
    <div className="hc-head">
      <div className="hc-head-top">
        <div className="hc-title">
          {isEditingTitle ? (
            // Esc cancels the rename, not the whole chat panel.
            <span className="hc-title-editor" data-owns-escape="">
              <input
                ref={titleInputRef}
                className="hc-title-input"
                type="text"
                value={draftTitle}
                onChange={(event) => {
                  setDraftTitle(event.target.value);
                  setTitleEditError(null);
                }}
                onKeyDown={handleTitleKeyDown}
                disabled={isSavingTitle}
                aria-label="Chat title"
                data-testid="local-chat-title-input"
              />
              <span className="hc-title-edit-actions">
                <button
                  type="button"
                  className="hc-ctrl"
                  onClick={() => void saveTitle()}
                  disabled={isSavingTitle}
                  title="Save chat title"
                  aria-label="Save chat title"
                  data-testid="local-chat-title-save"
                >
                  ✓
                </button>
                <button
                  type="button"
                  className="hc-ctrl"
                  onClick={cancelTitleEdit}
                  disabled={isSavingTitle}
                  title="Cancel chat title edit"
                  aria-label="Cancel chat title edit"
                  data-testid="local-chat-title-cancel"
                >
                  ×
                </button>
              </span>
            </span>
          ) : (
            <>
              <button
                ref={titleButtonRef}
                type="button"
                className="label hc-title-button"
                onClick={beginTitleEdit}
                disabled={!onTitleSave || isTitleRegenerating}
                title={onTitleSave ? "Rename chat" : undefined}
                aria-label={`Rename chat: ${label}`}
                data-testid="local-chat-title-button"
              >
                {label}
              </button>
              {isTitleRegenerating && (
                <span
                  className="hc-title-spinner"
                  role="status"
                  aria-label="Regenerating chat title"
                  data-testid="local-chat-title-regenerating"
                >
                  <SvgIcon size="h-3.5 w-3.5" className="animate-spin">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 4v5h5M20 20v-5h-5M5.5 15a7 7 0 0011.8 1.2L20 15M4 9a7 7 0 0111.8-1.2L20 9"
                    />
                  </SvgIcon>
                </span>
              )}
            </>
          )}
          {showProjectContext && (
            <span
              className="hc-project-context"
              data-testid="local-chat-project-context"
              role="note"
              aria-label={`Project: ${projectLabel}`}
              title={`Project: ${projectLabel}`}
            >
              {projectLabel}
            </span>
          )}
          {entity && (
            <IdChip
              id={entity.id}
              level={entity.level}
              className="hc-entity-id"
              testId="chat-header-entity-id"
            />
          )}
          {linkedPr && (
            <ChatHeaderPrChip
              pr={linkedPr}
              checks={linkedPrChecks}
              openThreads={linkedPrOpenThreads}
              onOpenChanges={onOpenPrInChanges}
            />
          )}
          <ChatAttentionDot attention={attention} />
          {attention.state !== "idle" &&
            CHAT_ATTENTION[attention.state].needsUser && (
              <span
                className="hc-attention-reason"
                data-attention={attention.state}
                data-testid="chat-attention-reason"
                aria-hidden="true"
              >
                {attention.reason ?? CHAT_ATTENTION[attention.state].label}
              </span>
            )}
        </div>
        {(titleEditError || titleError) && (
          <span className="hc-title-error" role="alert">
            {titleEditError || titleError}
          </span>
        )}
        <HeaderActionButtons actions={actions} />
      </div>
    </div>
  );
}
