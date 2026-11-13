import { useCallback, useEffect, useRef, useState } from "react";
import { StopIcon } from "../panels";
import type { LocalChatLifecycle } from "../../stores/chatStore";
import { FALLBACK_CHAT_PROJECT_LABEL } from "../../utils/localChatSessionGroups";

interface ChatHeaderProps {
  label: string;
  lifecycle: LocalChatLifecycle;
  isActive: boolean;
  isClosing: boolean;
  canStopGeneration: boolean;
  onClosePanel?: () => void;
  onStartFresh?: () => void;
  onToggleHistory?: () => void;
  onToggleChanges?: () => void;
  changesOpen?: boolean;
  onToggleBackground?: () => void;
  backgroundOpen?: boolean;
  backgroundRunning?: number;
  onToggleWide?: () => void;
  isWide?: boolean;
  onSplitPane?: () => void;
  canSplitPane?: boolean;
  onUnsplitPanes?: () => void;
  onClosePane?: () => void;
  onClearMessages: () => void;
  onStopGeneration: () => void;
  onTitleSave?: (title: string) => void | Promise<void>;
  onTitleRegenerate?: () => void;
  isTitleRegenerating?: boolean;
  titleError?: string | null;
  projectLabel?: string;
  showProjectContext?: boolean;
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
  icon: React.ReactNode;
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

interface PaneControlProps {
  onClosePanel?: () => void;
  onToggleWide?: () => void;
  isWide?: boolean;
  onSplitPane?: () => void;
  canSplitPane?: boolean;
  onUnsplitPanes?: () => void;
  onClosePane?: () => void;
}

/** Window controls shared by local chat and run pane headers; closePanel last. */
function buildPaneActions({
  onClosePanel,
  onToggleWide,
  isWide = false,
  onSplitPane,
  canSplitPane = true,
  onUnsplitPanes,
  onClosePane,
}: PaneControlProps): HeaderAction[] {
  return [
    {
      key: "wide",
      title: isWide ? "Collapse chat panel" : "Widen chat panel",
      ariaLabel: isWide ? "Collapse chat panel" : "Widen chat panel",
      onClick: onToggleWide!,
      show: !!onToggleWide,
      icon: isWide ? (
        <SvgIcon size="h-3.5 w-3.5">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 9H4V4m0 5 5-5m6 5h5V4m0 5-5-5M9 15H4v5m0-5 5 5m6-5h5v5m0-5-5 5"
          />
        </SvgIcon>
      ) : (
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
      key: "split",
      title: canSplitPane ? "Split chat pane" : "No more chat panes fit",
      ariaLabel: "Split chat pane",
      onClick: onSplitPane!,
      show: !!onSplitPane,
      disabled: !canSplitPane,
      icon: (
        <SvgIcon size="h-3.5 w-3.5">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 5h7v14H4zM13 5h7v14h-7z"
          />
        </SvgIcon>
      ),
    },
    {
      key: "unsplit",
      title: "Keep only this pane",
      ariaLabel: "Keep only this pane",
      onClick: onUnsplitPanes!,
      show: !!onUnsplitPanes,
      icon: (
        <SvgIcon size="h-3.5 w-3.5">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M5 5h14v14H5zM9 9l3 3m0 0 3-3m-3 3v6"
          />
        </SvgIcon>
      ),
    },
    {
      key: "closePane",
      title: "Close this pane",
      ariaLabel: "Close this pane",
      onClick: onClosePane!,
      show: !!onClosePane,
      icon: (
        <SvgIcon size="h-3.5 w-3.5">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </SvgIcon>
      ),
    },
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
  return (
    <div className="hc-ctrls">
      {actions
        .filter((action) => action.show)
        .map((action) => (
          <button
            key={action.key}
            className={`hc-ctrl${action.className ? ` ${action.className}` : ""}`}
            onClick={action.onClick}
            disabled={action.disabled}
            title={action.title}
            aria-label={action.ariaLabel}
            data-testid={action.testId}
            aria-pressed={action.pressed}
            aria-expanded={
              action.key === "changes" || action.key === "background"
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
        ))}
    </div>
  );
}

/** Window controls (widen, split, close pane, close panel) for non-chat panes. */
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
  lifecycle,
  isActive,
  isClosing,
  canStopGeneration,
  onClosePanel,
  onStartFresh,
  onToggleHistory,
  onToggleChanges,
  changesOpen = false,
  onToggleBackground,
  backgroundOpen = false,
  backgroundRunning = 0,
  onToggleWide,
  isWide = false,
  onSplitPane,
  canSplitPane = true,
  onUnsplitPanes,
  onClosePane,
  onClearMessages,
  onStopGeneration,
  onTitleSave,
  onTitleRegenerate,
  isTitleRegenerating = false,
  titleError,
  projectLabel = FALLBACK_CHAT_PROJECT_LABEL,
  showProjectContext = false,
}: ChatHeaderProps) {
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState(label);
  const [titleEditError, setTitleEditError] = useState<string | null>(null);
  const [isSavingTitle, setIsSavingTitle] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleButtonRef = useRef<HTMLButtonElement>(null);
  const restoreTitleFocus = useRef(false);

  useEffect(() => {
    if (!isEditingTitle) setDraftTitle(label);
  }, [isEditingTitle, label]);

  useEffect(() => {
    if (isEditingTitle) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
      return;
    }
    if (restoreTitleFocus.current) {
      titleButtonRef.current?.focus();
      restoreTitleFocus.current = false;
    }
  }, [isEditingTitle]);

  const beginTitleEdit = useCallback(() => {
    if (!onTitleSave || isTitleRegenerating || isSavingTitle) return;
    setDraftTitle(label);
    setTitleEditError(null);
    setIsEditingTitle(true);
  }, [isSavingTitle, isTitleRegenerating, label, onTitleSave]);

  const cancelTitleEdit = useCallback(() => {
    setDraftTitle(label);
    setTitleEditError(null);
    restoreTitleFocus.current = true;
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
      restoreTitleFocus.current = true;
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

  const paneActions = buildPaneActions({
    onClosePanel,
    onToggleWide,
    isWide,
    onSplitPane,
    canSplitPane,
    onUnsplitPanes,
    onClosePane,
  });

  const actions: HeaderAction[] = [
    {
      key: "changes",
      title: changesOpen
        ? "Hide Changes panel (⌘⇧B when worktree has changes)"
        : "Show Changes panel (⌘⇧B when worktree has changes)",
      ariaLabel: "Changes",
      onClick: onToggleChanges!,
      show: !!onToggleChanges,
      pressed: changesOpen,
      testId: "local-chat-view-changes",
      icon: (
        <SvgIcon size="h-3.5 w-3.5">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M15 4v16M6 9h6M9 6v6M6 16h6" />
        </SvgIcon>
      ),
    },
    {
      key: "background",
      title: backgroundOpen
        ? "Hide Background tasks panel"
        : "Show Background tasks panel",
      ariaLabel:
        backgroundRunning > 0
          ? `Background tasks, ${backgroundRunning} running`
          : "Background tasks",
      onClick: onToggleBackground!,
      show: !!onToggleBackground,
      pressed: backgroundOpen,
      badge: backgroundRunning,
      testId: "local-chat-view-background",
      icon: (
        <SvgIcon size="h-3.5 w-3.5">
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v4l2.5 2.5" />
        </SvgIcon>
      ),
    },
    {
      key: "fresh",
      title: "Start fresh local chat",
      ariaLabel: "Start fresh local chat",
      onClick: onStartFresh!,
      show: !!onStartFresh,
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
      key: "history",
      title: "Toggle chat history",
      ariaLabel: "Toggle chat history",
      onClick: onToggleHistory!,
      show: !!onToggleHistory && !isWide,
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
    ...paneActions.slice(0, -1),
    {
      key: "clear",
      title: "Clear messages",
      ariaLabel: "Clear messages",
      onClick: onClearMessages,
      show: true,
      disabled: isClosing,
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
      key: "stop",
      title: "Stop generation (Cmd+.)",
      ariaLabel: "Stop generation",
      onClick: onStopGeneration,
      show: true,
      disabled: !canStopGeneration,
      className: "danger",
      testId: "local-chat-stop-generation",
      icon: <StopIcon />,
    },
    ...paneActions.slice(-1),
  ];

  return (
    <div className="hc-head">
      <div className="hc-head-top">
        <div className="hc-title">
          {isEditingTitle ? (
            <span className="hc-title-editor">
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
              {onTitleRegenerate && (
                <button
                  type="button"
                  className="hc-ctrl hc-title-regenerate"
                  onClick={onTitleRegenerate}
                  disabled={isTitleRegenerating || isSavingTitle}
                  title="Regenerate chat title"
                  aria-label={
                    isTitleRegenerating
                      ? "Regenerating chat title"
                      : "Regenerate chat title"
                  }
                  data-testid="local-chat-title-regenerate"
                >
                  <SvgIcon
                    size="h-3.5 w-3.5"
                    className={isTitleRegenerating ? "animate-spin" : undefined}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 4v5h5M20 20v-5h-5M5.5 15a7 7 0 0011.8 1.2L20 15M4 9a7 7 0 0111.8-1.2L20 9"
                    />
                  </SvgIcon>
                </button>
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
          {lifecycle === "error" ? (
            <span
              data-testid="chat-error-dot"
              className="em"
              style={{
                background: "var(--color-err)",
                boxShadow:
                  "0 0 6px color-mix(in oklch, var(--color-err) 60%, transparent)",
              }}
            />
          ) : isActive ? (
            <span data-testid="chat-active-dot" className="em ok" />
          ) : lifecycle === "closed" ? (
            <span data-testid="chat-closed-dot" className="em mute" />
          ) : (
            <span className="em" />
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
