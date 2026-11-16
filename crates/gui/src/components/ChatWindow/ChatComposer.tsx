import { useEffect, useRef, useState } from "react";
import { ChatInput } from "../ChatInput";
import { formatTokenCount } from "../../utils/modelContextWindow";
import type {
  LocalChatHarnessCatalog,
  LocalChatHarnessInfo,
  LocalChatProviderInfo,
  PermissionMode,
} from "../../bindings";
import type { ChatSession } from "../../stores/chatStore";
import {
  diffCommentHomeLabel,
  diffCommentLocation,
  formatTextCommentsForReply,
  replyHunk,
  type PendingComment,
  type PendingDiffComment,
} from "./assistantTextComments";
import { CommentShortcutHint } from "./CommentShortcutHint";
import "./chatComments.css";

/** A code selection sent to the main chat; its own text is optional. */
function isAttachment(comment: PendingComment): boolean {
  return comment.kind === "diff" && comment.selectionCode !== undefined;
}

/** `file.ts:12-14` for a chip; the full path is in the popover. */
function chipDiffLabel(comment: PendingDiffComment): string {
  const name = comment.path.split("/").pop() || comment.path;
  const range =
    comment.endLine === comment.startLine
      ? `${comment.startLine}`
      : `${comment.startLine}-${comment.endLine}`;
  return `${name}:${range}`;
}
import {
  LOCAL_CHAT_HARNESS_UNAVAILABLE_MESSAGE,
  LOCAL_CHAT_UNAVAILABLE_MESSAGE,
} from "./chatHelpers";
import { Dropdown } from "../molecules/Dropdown";
import { Select } from "../atoms/Select";

type PermissionModeOption = {
  value: PermissionMode;
  label: string;
};

const CLAUDE_PERMISSION_MODE_OPTIONS: PermissionModeOption[] = [
  { value: "default", label: "Ask before edits" },
  { value: "accept_edits", label: "Edit automatically" },
  { value: "plan", label: "Plan mode" },
  { value: "auto", label: "Auto mode" },
  { value: "dont_ask", label: "Don't ask" },
  { value: "bypass_permissions", label: "Bypass permissions" },
];

const CODEX_PERMISSION_MODE_OPTIONS: PermissionModeOption[] = [
  { value: "default", label: "Ask for approval" },
  { value: "auto", label: "Approve for me" },
  { value: "bypass_permissions", label: "Full access" },
];

function permissionModeOptions(
  harness: ChatSession["harness"],
  catalogOptions?: LocalChatHarnessInfo["permission_modes"]
) {
  // New catalogs always report the provider-owned options. Keep the legacy
  // fallback for older cached/test catalogs that predate permission_modes.
  if (catalogOptions) {
    return catalogOptions.map((mode) => ({
      value: mode.id,
      label: mode.label,
    }));
  }
  return harness === "codex"
    ? CODEX_PERMISSION_MODE_OPTIONS
    : CLAUDE_PERMISSION_MODE_OPTIONS;
}

function useHarnessPickerState(
  visibleHarness: LocalChatHarnessInfo | null,
  session: ChatSession,
  isActive: boolean,
  lockedHarness: boolean,
  hasResume: boolean,
  hasAvailableHarness: boolean,
  supportedModelIds: Set<string>,
  reasoningEfforts: LocalChatHarnessInfo["reasoning_efforts"],
  supportedReasoningEffortIds: Set<string>,
  supportedSpeedTierIds: Set<string>
) {
  if (!visibleHarness) return null;

  const selectedModelUnsupported =
    !!session.selectedModelId &&
    !supportedModelIds.has(session.selectedModelId);
  const selectedReasoningEffortUnsupported =
    !!session.selectedReasoningEffort &&
    !supportedReasoningEffortIds.has(session.selectedReasoningEffort);
  const selectedSpeedTierUnsupported =
    !!session.selectedSpeedTier &&
    !supportedSpeedTierIds.has(session.selectedSpeedTier);

  // Model and effort apply per turn: a live or resumed conversation switches
  // in place on its next turn, so neither picker locks once it has started.
  // Without a selection a started conversation keeps its current setting.
  const hasConversation =
    isActive || lockedHarness || hasResume || !!session.providerResumeId;
  const modelPickerDisabled =
    !visibleHarness.available || (visibleHarness.models ?? []).length === 0;
  const modelDefaultLabel = hasConversation
    ? "Current model"
    : visibleHarness.default_model_id
      ? "Default model"
      : "CLI default";

  const effortPickerDisabled =
    !visibleHarness.available || reasoningEfforts.length === 0;
  const effortDefaultLabel = hasConversation
    ? "Current effort"
    : visibleHarness.default_reasoning_effort
      ? "Default effort"
      : "Provider default";
  const speedPickerDisabled =
    !visibleHarness.available || supportedSpeedTierIds.size === 0;
  const speedPickerDisabledReason = !visibleHarness.available
    ? LOCAL_CHAT_HARNESS_UNAVAILABLE_MESSAGE
    : undefined;

  const unavailableMessage = !visibleHarness.available
    ? lockedHarness
      ? LOCAL_CHAT_HARNESS_UNAVAILABLE_MESSAGE
      : !hasAvailableHarness
        ? LOCAL_CHAT_UNAVAILABLE_MESSAGE
        : null
    : null;

  return {
    hasConversation,
    selectedModelUnsupported,
    selectedReasoningEffortUnsupported,
    modelPickerDisabled,
    modelDefaultLabel,
    effortPickerDisabled,
    effortDefaultLabel,
    selectedSpeedTierUnsupported,
    speedPickerDisabled,
    speedPickerDisabledReason,
    unavailableMessage,
  };
}

interface ChatComposerProps {
  session: ChatSession;
  inputValue: string;
  setInputValue: (value: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  harnessCatalog: LocalChatHarnessCatalog | null;
  visibleHarness: LocalChatHarnessInfo | null;
  providerOptions: Array<{
    provider: LocalChatProviderInfo;
    info: LocalChatHarnessInfo;
  }>;
  /** Provider selected for the session; the harness is derived from it. */
  selectedProviderId: string;
  supportedModelIds: Set<string>;
  reasoningEfforts?: LocalChatHarnessInfo["reasoning_efforts"];
  supportedReasoningEffortIds: Set<string>;
  speedTiers: NonNullable<LocalChatHarnessInfo["speed_tiers"]>;
  supportedSpeedTierIds: Set<string>;
  isBusy: boolean;
  isActive: boolean;
  lockedHarness: boolean;
  hasResume: boolean;
  hasAvailableHarness: boolean;
  canUseComposer: boolean;
  canSendMessage: boolean;
  shouldStartOrResume: boolean;
  submitLabel: string;
  composerPlaceholder: string;
  ctxPct: number;
  ctxColor: string;
  usage: { used: number; max: number } | null;
  threadTotalTokens?: number;
  pendingComments?: readonly PendingComment[];
  onUpdateComment?: (id: string, body: string) => void;
  onRemoveComment?: (id: string) => void;
  /** Bring a diff comment into view in the diff it was written on. */
  onNavigateComment?: (id: string) => void;
  /** The hovered or pinned comment, whose target is highlighted. */
  onActiveCommentChange?: (id: string | null) => void;
  onSend: (message?: string) => boolean | void;
  onStartSession: (initialPrompt?: string) => boolean | void;
  onHarnessChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  onModelChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  onReasoningEffortChange: (
    event: React.ChangeEvent<HTMLSelectElement>
  ) => void;
  onSpeedTierChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  onPermissionModeChange: (value: string) => void;
}

export function ChatComposer({
  session,
  inputValue,
  setInputValue,
  inputRef,
  harnessCatalog,
  visibleHarness,
  providerOptions,
  selectedProviderId,
  supportedModelIds,
  reasoningEfforts,
  supportedReasoningEffortIds,
  speedTiers,
  supportedSpeedTierIds,
  isBusy,
  isActive,
  lockedHarness,
  hasResume,
  hasAvailableHarness,
  canUseComposer,
  canSendMessage,
  shouldStartOrResume,
  submitLabel,
  composerPlaceholder,
  ctxPct,
  ctxColor,
  usage,
  threadTotalTokens,
  pendingComments = [],
  onUpdateComment,
  onRemoveComment,
  onNavigateComment,
  onActiveCommentChange,
  onSend,
  onStartSession,
  onHarnessChange,
  onModelChange,
  onReasoningEffortChange,
  onSpeedTierChange,
  onPermissionModeChange,
}: ChatComposerProps) {
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [pinnedCommentId, setPinnedCommentId] = useState<string | null>(null);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingCommentBody, setEditingCommentBody] = useState("");
  const [chipFocusIndex, setChipFocusIndex] = useState<number | null>(null);
  const [keyboardChipId, setKeyboardChipId] = useState<string | null>(null);
  const chipRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const pointerFocusRef = useRef(false);
  const commentsAccessoryRef = useRef<HTMLDivElement | null>(null);
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const modelSettingsRef = useRef<HTMLDivElement | null>(null);
  const modelSettingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!modelSettingsOpen) return;
    const dismiss = (event: PointerEvent | MouseEvent) => {
      if (!modelSettingsRef.current?.contains(event.target as Node)) {
        setModelSettingsOpen(false);
      }
    };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [modelSettingsOpen]);
  useEffect(() => {
    if (
      pinnedCommentId &&
      !pendingComments.some((comment) => comment.id === pinnedCommentId)
    ) {
      setPinnedCommentId(null);
      setActiveCommentId(null);
      setEditingCommentId(null);
    }
  }, [pendingComments, pinnedCommentId]);
  useEffect(() => {
    if (
      !pinnedCommentId ||
      !pendingComments.some((comment) => comment.id === pinnedCommentId)
    ) {
      return;
    }

    const dismissPinnedComment = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !commentsAccessoryRef.current?.contains(target)
      ) {
        setPinnedCommentId(null);
        setActiveCommentId(null);
      }
    };
    document.addEventListener("pointerdown", dismissPinnedComment);
    return () =>
      document.removeEventListener("pointerdown", dismissPinnedComment);
  }, [pendingComments, pinnedCommentId]);
  const availableReasoningEfforts =
    reasoningEfforts ?? visibleHarness?.reasoning_efforts ?? [];
  const availablePermissionModes = permissionModeOptions(
    session.harness,
    visibleHarness?.permission_modes
  );
  const picker = useHarnessPickerState(
    visibleHarness,
    session,
    isActive,
    lockedHarness,
    hasResume,
    hasAvailableHarness,
    supportedModelIds,
    availableReasoningEfforts,
    supportedReasoningEffortIds,
    supportedSpeedTierIds
  );
  const defaultSpeedTierId =
    speedTiers.find((tier) => tier.is_default)?.id ?? speedTiers[0]?.id ?? "";
  const modelSummary = (() => {
    if (!visibleHarness || !picker) return null;
    const selectedModel = (visibleHarness.models ?? []).find(
      (model) => model.id === session.selectedModelId
    );
    const modelLabel =
      selectedModel?.label ??
      (session.selectedModelId && session.selectedModelId !== "default"
        ? session.selectedModelId
        : picker.modelDefaultLabel);
    const selectedEffort = availableReasoningEfforts.find(
      (effort) => effort.id === session.selectedReasoningEffort
    );
    const selectedTier = speedTiers.find(
      (tier) => tier.id === session.selectedSpeedTier
    );
    const parts = [modelLabel];
    if (selectedEffort) parts.push(selectedEffort.label);
    if (selectedTier && selectedTier.id !== defaultSpeedTierId) {
      parts.push(selectedTier.label);
    }
    return {
      providerLabel:
        providerOptions.find(
          ({ provider }) => provider.id === selectedProviderId
        )?.provider.label ?? visibleHarness.label,
      text: parts.join(" · "),
      needsAttention:
        picker.selectedModelUnsupported ||
        picker.selectedReasoningEffortUnsupported ||
        picker.selectedSpeedTierUnsupported,
    };
  })();
  // A code attachment ("Send to main chat") may go without its own text: the
  // follow-up or another comment carries the question.
  const hasReadyComments =
    pendingComments.length > 0 &&
    pendingComments.every(
      (comment) => comment.body.trim().length > 0 || isAttachment(comment)
    ) &&
    (inputValue.trim().length > 0 ||
      pendingComments.some((comment) => comment.body.trim().length > 0));
  const canSubmitComments =
    hasReadyComments && (canSendMessage || shouldStartOrResume);
  const submit = () => {
    const followUp = inputValue.trim();
    if (!pendingComments.length) {
      if (canSendMessage) onSend();
      else onStartSession();
      return;
    }
    if (!hasReadyComments) return;

    const message = formatTextCommentsForReply(pendingComments, followUp);
    if (canSendMessage) onSend(message);
    else onStartSession(message);
  };
  const shownCommentId = pinnedCommentId ?? activeCommentId;
  useEffect(() => {
    onActiveCommentChange?.(shownCommentId);
  }, [shownCommentId, onActiveCommentChange]);
  const closeCommentPopover = () => {
    setPinnedCommentId(null);
    setActiveCommentId(null);
    setEditingCommentId(null);
  };
  const saveEditedComment = (comment: PendingComment) => {
    const body = editingCommentBody.trim();
    if (!body && !isAttachment(comment)) return;
    onUpdateComment?.(comment.id, body);
    setEditingCommentId(null);
  };

  // Keyboard navigation: the chip row is one Tab stop (roving tabindex);
  // ⌘⌥↑ from the input enters it, since plain ↑/↓ belong to message history.
  const rovingIndex = Math.min(
    chipFocusIndex ?? pendingComments.length - 1,
    pendingComments.length - 1
  );
  // A new set of comments starts from the last chip again.
  if (!pendingComments.length && chipFocusIndex !== null)
    setChipFocusIndex(null);
  const focusChip = (index: number) => {
    const target = Math.max(0, Math.min(index, pendingComments.length - 1));
    setChipFocusIndex(target);
    chipRefs.current[target]?.focus();
  };
  const leaveChips = () => {
    closeCommentPopover();
    inputRef.current?.focus();
  };
  const startEditing = (comment: PendingComment) => {
    setPinnedCommentId(comment.id);
    setActiveCommentId(comment.id);
    setEditingCommentId(comment.id);
    setEditingCommentBody(comment.body);
  };
  const stopEditing = (index: number) => {
    setEditingCommentId(null);
    // The editor unmounts; keep the keyboard user on the chip they edited.
    requestAnimationFrame(() => chipRefs.current[index]?.focus());
  };
  const removeFromKeyboard = (index: number) => {
    onRemoveComment?.(pendingComments[index].id);
    closeCommentPopover();
    if (pendingComments.length === 1) {
      inputRef.current?.focus();
      return;
    }
    // After removal the following chip takes this index.
    const next = Math.min(index, pendingComments.length - 2);
    setChipFocusIndex(next);
    requestAnimationFrame(() => chipRefs.current[next]?.focus());
  };
  const handleChipKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    comment: PendingComment,
    index: number
  ) => {
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
    switch (event.key) {
      case "ArrowLeft":
        if (!plain) return;
        focusChip(index - 1);
        break;
      case "ArrowRight":
        if (!plain) return;
        focusChip(index + 1);
        break;
      case "Home":
        focusChip(0);
        break;
      case "End":
        focusChip(pendingComments.length - 1);
        break;
      case "Enter":
      case "e":
      case "E":
        if (!plain) return;
        startEditing(comment);
        break;
      case "Backspace":
      case "Delete":
        removeFromKeyboard(index);
        break;
      case "Escape":
        leaveChips();
        break;
      case "ArrowDown":
        if (!(event.metaKey && event.altKey)) return;
        leaveChips();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const commentsAccessory = pendingComments.length ? (
    <div
      ref={commentsAccessoryRef}
      className="chat-comment-chips"
      data-owns-escape=""
      data-testid="local-chat-pending-comments"
      aria-label={`${pendingComments.length} comments queued for your reply`}
    >
      {pendingComments.map((comment, index) => {
        const commentNumber = index + 1;
        const isPinned = pinnedCommentId === comment.id;
        const isActive = pinnedCommentId
          ? isPinned
          : activeCommentId === comment.id;
        const isEditing = editingCommentId === comment.id;
        const popoverId = `local-chat-comment-details-${comment.id}`;

        return (
          <div
            key={comment.id}
            data-testid="local-chat-pending-comment"
            onMouseEnter={() => setActiveCommentId(comment.id)}
            onMouseLeave={(event) => {
              if (
                !isPinned &&
                !event.currentTarget.contains(document.activeElement)
              ) {
                setActiveCommentId((current) =>
                  current === comment.id ? null : current
                );
              }
            }}
            onFocusCapture={() => {
              setActiveCommentId(comment.id);
              if (pinnedCommentId && pinnedCommentId !== comment.id) {
                setPinnedCommentId(null);
              }
            }}
            onBlurCapture={(event) => {
              const nextTarget = event.relatedTarget;
              if (
                !isPinned &&
                (!(nextTarget instanceof Node) ||
                  !event.currentTarget.contains(nextTarget))
              ) {
                if (!event.currentTarget.matches(":hover")) {
                  setActiveCommentId((current) =>
                    current === comment.id ? null : current
                  );
                }
              }
            }}
          >
            <button
              type="button"
              ref={(element) => {
                chipRefs.current[index] = element;
              }}
              tabIndex={index === rovingIndex ? 0 : -1}
              onKeyDown={(event) => handleChipKeyDown(event, comment, index)}
              onPointerDown={() => {
                pointerFocusRef.current = true;
              }}
              onFocus={() => {
                setChipFocusIndex(index);
                // Key hints are for keyboard focus only. After a click the
                // hint would vanish on the next press elsewhere in the card,
                // shifting the card under the pointer mid-click.
                if (!pointerFocusRef.current) setKeyboardChipId(comment.id);
                pointerFocusRef.current = false;
              }}
              onBlur={() =>
                setKeyboardChipId((current) =>
                  current === comment.id ? null : current
                )
              }
              className="chat-comment-chip"
              data-testid={`local-chat-comment-icon-${commentNumber}`}
              aria-label={`Comment ${commentNumber} details`}
              aria-controls={popoverId}
              aria-expanded={isActive}
              aria-pressed={isPinned}
              title={`Click to ${isPinned ? "close" : "keep open"} comment ${commentNumber}`}
              onClick={() => {
                if (isPinned) {
                  closeCommentPopover();
                } else {
                  setPinnedCommentId(comment.id);
                  setActiveCommentId(comment.id);
                  onNavigateComment?.(comment.id);
                }
              }}
            >
              <span className="chat-comment-chip-number" aria-hidden="true">
                {commentNumber}
              </span>
              {comment.kind === "diff" ? (
                <span className="chat-comment-chip-label" data-mono="">
                  {comment.selectionCode !== undefined && (
                    <span className="selection-chip-label sr-only">
                      {diffCommentLocation(comment)}
                    </span>
                  )}
                  {chipDiffLabel(comment)}
                </span>
              ) : (
                <span className="chat-comment-chip-label">
                  “{comment.quote.replace(/\s+/g, " ").trim()}”
                </span>
              )}
            </button>
            {isActive ? (
              <div
                id={popoverId}
                className="chat-comment-card absolute bottom-full left-0 z-[90] mb-2"
                role="group"
                aria-label={`Comment ${commentNumber} details`}
                data-testid="local-chat-comment-popover"
                onKeyDown={(event) => {
                  if (event.key === "Escape") closeCommentPopover();
                }}
              >
                <div className="chat-comment-card-header">
                  <span className="chat-comment-card-title">
                    {comment.kind === "diff" ? (
                      <>
                        {diffCommentHomeLabel(comment)} ·{" "}
                        <span className="mono">
                          {diffCommentLocation(comment)}
                        </span>{" "}
                        ({comment.side}){comment.outdated ? " · outdated" : ""}
                      </>
                    ) : (
                      "Selected text"
                    )}
                  </span>
                  {!isEditing ? (
                    <>
                      <button
                        type="button"
                        aria-label={`Edit comment ${commentNumber}`}
                        title={`Edit comment ${commentNumber}`}
                        className="chat-comment-icon-button"
                        onClick={() => startEditing(comment)}
                      >
                        <svg
                          aria-hidden="true"
                          width="14"
                          height="14"
                          fill="none"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          viewBox="0 0 24 24"
                        >
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove comment ${commentNumber}`}
                        title={`Remove comment ${commentNumber}`}
                        className="chat-comment-icon-button"
                        data-tone="danger"
                        onClick={() => {
                          onRemoveComment?.(comment.id);
                          closeCommentPopover();
                        }}
                      >
                        <svg
                          aria-hidden="true"
                          width="14"
                          height="14"
                          fill="none"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          viewBox="0 0 24 24"
                        >
                          <path d="M3 6h18" />
                          <path d="M8 6V4h8v2" />
                          <path d="m19 6-1 14H6L5 6" />
                          <path d="M10 11v5M14 11v5" />
                        </svg>
                      </button>
                    </>
                  ) : null}
                </div>
                {comment.kind === "diff" ? (
                  <pre
                    className="chat-comment-quote chat-comment-quote-code"
                    data-testid="local-chat-comment-hunk"
                  >
                    {replyHunk(comment)}
                  </pre>
                ) : (
                  <blockquote className="chat-comment-quote">
                    {comment.contextBefore ? (
                      <span>{comment.contextBefore}</span>
                    ) : null}
                    <mark>{comment.quote}</mark>
                    {comment.contextAfter ? (
                      <span>{comment.contextAfter}</span>
                    ) : null}
                  </blockquote>
                )}
                {isEditing ? (
                  <>
                    <textarea
                      aria-label={`Edit comment ${commentNumber}`}
                      data-testid="local-chat-comment-editor"
                      className="chat-comment-textarea"
                      value={editingCommentBody}
                      autoFocus
                      // Continue the existing text rather than prepend to it.
                      onFocus={(event) => {
                        const end = event.currentTarget.value.length;
                        event.currentTarget.setSelectionRange(end, end);
                      }}
                      onChange={(event) =>
                        setEditingCommentBody(event.target.value)
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          stopEditing(index);
                        } else if (
                          event.key === "Enter" &&
                          (event.metaKey || event.ctrlKey)
                        ) {
                          event.preventDefault();
                          saveEditedComment(comment);
                        }
                      }}
                      rows={3}
                    />
                    <div className="chat-comment-card-footer">
                      <CommentShortcutHint action="save" />
                      <button
                        type="button"
                        className="chat-comment-button"
                        aria-label={`Cancel editing comment ${commentNumber}`}
                        title={`Cancel editing comment ${commentNumber}`}
                        onClick={() => stopEditing(index)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="chat-comment-button"
                        data-primary=""
                        aria-label={`Save comment ${commentNumber}`}
                        title={`Save comment ${commentNumber}`}
                        data-testid="local-chat-save-edited-comment"
                        disabled={
                          !editingCommentBody.trim() && !isAttachment(comment)
                        }
                        onClick={() => saveEditedComment(comment)}
                      >
                        Save
                      </button>
                    </div>
                  </>
                ) : (
                  <p
                    className="chat-comment-body"
                    data-testid="local-chat-comment-body"
                    data-empty={comment.body.trim() ? undefined : ""}
                  >
                    {comment.body.trim()
                      ? comment.body
                      : "No comment — attached as context"}
                  </p>
                )}
                {keyboardChipId === comment.id && !isEditing ? (
                  <div
                    className="chat-comment-card-footer"
                    data-testid="local-chat-comment-keys"
                  >
                    <span className="chat-comment-hint" aria-hidden="true">
                      <kbd className="chat-comment-kbd">←→</kbd> move ·
                      <kbd className="chat-comment-kbd">↵</kbd> edit ·
                      <kbd className="chat-comment-kbd">⌫</kbd> remove ·
                      <kbd className="chat-comment-kbd">esc</kbd> back
                    </span>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  ) : null;

  return (
    <div
      className="hc-foot"
      onKeyDown={(event) => {
        if (
          event.target !== inputRef.current ||
          event.key !== "ArrowUp" ||
          !event.metaKey ||
          !event.altKey ||
          event.shiftKey ||
          !pendingComments.length
        )
          return;
        event.preventDefault();
        focusChip(rovingIndex);
      }}
    >
      <div className="hc-ctx">
        <div
          className="hc-ctx-fill"
          data-testid="chat-context-fill"
          style={{ width: `${ctxPct}%`, background: ctxColor }}
        />
      </div>
      <div className="p-3">
        <ChatInput
          ref={inputRef}
          value={inputValue}
          onChange={setInputValue}
          onSubmit={submit}
          disabled={!canUseComposer}
          canSubmit={
            canUseComposer &&
            (pendingComments.length > 0
              ? canSubmitComments
              : inputValue.trim().length > 0 &&
                (canSendMessage || shouldStartOrResume))
          }
          placeholder={composerPlaceholder}
          buttonTitle={submitLabel}
          buttonAriaLabel={submitLabel}
          textareaTestId="local-chat-composer"
          inputAccessory={commentsAccessory}
          footerLeft={
            <div className="hc-chat-controls">
              <span className="hc-permission-picker">
                <Dropdown
                  variant="quiet"
                  placement="up"
                  aria-label="Local chat permission mode"
                  data-testid="local-chat-permission-mode-picker"
                  value={session.permissionMode ?? "default"}
                  onChange={onPermissionModeChange}
                  options={availablePermissionModes.map((mode) => ({
                    value: mode.value,
                    label: mode.label,
                  }))}
                />
              </span>
            </div>
          }
          footerRight={
            <div className="hc-chat-controls right">
              {picker?.selectedModelUnsupported && !picker.hasConversation && (
                <span role="alert" className="hc-composer-alert">
                  Choose an available model or reset to Default model to start
                  this chat.
                </span>
              )}
              {picker?.unavailableMessage && (
                <span
                  className="hc-provider-unavailable"
                  data-testid="local-chat-provider-unavailable"
                >
                  {picker.unavailableMessage}
                </span>
              )}
              {(visibleHarness && picker) || harnessCatalog ? (
                <div className="hc-model-settings" ref={modelSettingsRef}>
                  <button
                    ref={modelSettingsTriggerRef}
                    type="button"
                    className={`ctl ctl-quiet hc-model-chip${modelSummary?.needsAttention ? " attention" : ""}`}
                    aria-label={`Model settings: ${modelSummary ? `${modelSummary.providerLabel} · ${modelSummary.text}` : "provider"}`}
                    aria-haspopup="dialog"
                    aria-expanded={modelSettingsOpen}
                    data-testid="local-chat-model-settings"
                    title={
                      modelSummary
                        ? `${modelSummary.providerLabel} · ${modelSummary.text}`
                        : "Choose a provider"
                    }
                    onClick={() => setModelSettingsOpen((open) => !open)}
                  >
                    <span className="hc-model-chip-provider">
                      {modelSummary?.providerLabel ?? "Provider"}
                    </span>
                    {modelSummary && (
                      <span className="hc-model-chip-text">
                        {modelSummary.text}
                      </span>
                    )}
                    <span aria-hidden="true" className="ctl-caret" />
                  </button>
                  {modelSettingsOpen && (
                    <div
                      className="hc-model-pop"
                      role="dialog"
                      aria-label="Model settings"
                      data-testid="local-chat-model-settings-popover"
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          setModelSettingsOpen(false);
                          modelSettingsTriggerRef.current?.focus();
                        }
                      }}
                    >
                      {harnessCatalog && (
                        <div className="hc-model-row hc-provider-picker">
                          <span>Provider</span>
                          <Select
                            aria-label="Local chat provider"
                            data-testid="local-chat-provider-picker"
                            value={selectedProviderId}
                            onChange={onHarnessChange}
                            disabled={isBusy || isActive || lockedHarness}
                            options={providerOptions.map(({ provider }) => ({
                              value: provider.id,
                              label: provider.label,
                            }))}
                          />
                        </div>
                      )}
                      {visibleHarness && picker && (
                        <>
                          <div className="hc-model-row hc-model-picker">
                            <span>Model</span>
                            <Select
                              aria-label={`${visibleHarness.label} model`}
                              data-testid="local-chat-model-picker"
                              value={
                                selectedProviderId === "openai" &&
                                session.selectedModelId === "default"
                                  ? ""
                                  : (session.selectedModelId ?? "")
                              }
                              onChange={onModelChange}
                              disabled={picker.modelPickerDisabled}
                              options={[
                                { value: "", label: picker.modelDefaultLabel },
                                ...(picker.selectedModelUnsupported
                                  ? [
                                      {
                                        value: session.selectedModelId ?? "",
                                        label: `Unsupported: ${session.selectedModelId}`,
                                      },
                                    ]
                                  : []),
                                ...(visibleHarness.models ?? [])
                                  .filter(
                                    (model) =>
                                      !(
                                        selectedProviderId === "openai" &&
                                        model.id === "default"
                                      )
                                  )
                                  .map((model) => ({
                                    value: model.id,
                                    label:
                                      model.label +
                                      (model.id ===
                                      visibleHarness.default_model_id
                                        ? " (default)"
                                        : ""),
                                  })),
                              ]}
                            />
                          </div>
                          {availableReasoningEfforts.length > 0 && (
                            <div className="hc-model-row hc-effort-picker">
                              <span>Effort</span>
                              <Select
                                aria-label={`${visibleHarness.label} reasoning effort`}
                                data-testid="local-chat-effort-picker"
                                value={session.selectedReasoningEffort ?? ""}
                                onChange={onReasoningEffortChange}
                                disabled={picker.effortPickerDisabled}
                                options={[
                                  {
                                    value: "",
                                    label: picker.effortDefaultLabel,
                                  },
                                  ...(picker.selectedReasoningEffortUnsupported
                                    ? [
                                        {
                                          value:
                                            session.selectedReasoningEffort ??
                                            "",
                                          label: `Unsupported: ${session.selectedReasoningEffort}`,
                                        },
                                      ]
                                    : []),
                                  ...availableReasoningEfforts.map(
                                    (effort) => ({
                                      value: effort.id,
                                      label:
                                        effort.label +
                                        (effort.id ===
                                        visibleHarness.default_reasoning_effort
                                          ? " (default)"
                                          : ""),
                                    })
                                  ),
                                ]}
                              />
                            </div>
                          )}
                          {(speedTiers.length > 1 ||
                            picker.selectedSpeedTierUnsupported) && (
                            <div
                              className="hc-model-row hc-speed-picker"
                              title={picker.speedPickerDisabledReason}
                            >
                              <span>Speed</span>
                              <Select
                                aria-label={`${visibleHarness.label} speed tier`}
                                data-testid="local-chat-speed-tier-picker"
                                value={
                                  session.selectedSpeedTier ??
                                  (picker.hasConversation
                                    ? ""
                                    : defaultSpeedTierId)
                                }
                                onChange={onSpeedTierChange}
                                disabled={picker.speedPickerDisabled}
                                options={[
                                  ...(picker.hasConversation
                                    ? [{ value: "", label: "Current tier" }]
                                    : []),
                                  ...(picker.selectedSpeedTierUnsupported
                                    ? [
                                        {
                                          value:
                                            session.selectedSpeedTier ?? "",
                                          label: `Unsupported: ${session.selectedSpeedTier}`,
                                        },
                                      ]
                                    : []),
                                  ...speedTiers.map((tier) => ({
                                    value: tier.id,
                                    label: tier.label,
                                  })),
                                ]}
                              />
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          }
        />
      </div>
      <div
        className="hc-foot-meta"
        aria-hidden={usage && usage.max > 0 ? undefined : true}
      >
        {usage && usage.max > 0 ? (
          <span
            className="ctx-lbl"
            title={`${usage.used.toLocaleString()} / ${usage.max.toLocaleString()} current request input context tokens${threadTotalTokens !== undefined ? ` · ${threadTotalTokens.toLocaleString()} total thread tokens` : ""}`}
          >
            context <b>{ctxPct}%</b>
            {session.model
              ? ` · ${session.model.replace(/^claude-/i, "")} · ${formatTokenCount(usage.used)}/${formatTokenCount(usage.max)}`
              : ""}
            {threadTotalTokens !== undefined
              ? ` · thread ${formatTokenCount(threadTotalTokens)}`
              : ""}
          </span>
        ) : (
          <span className="ctx-lbl">&nbsp;</span>
        )}
      </div>
    </div>
  );
}
