import { useEffect, useRef, useState } from "react";
import { ChatInput } from "../ChatInput";
import { formatTokenCount } from "../../utils/modelContextWindow";
import type {
  LocalChatHarnessCatalog,
  LocalChatHarnessInfo,
  PermissionMode,
} from "../../bindings";
import type { ChatSession } from "../../stores/chatStore";
import {
  formatTextCommentsForReply,
  type PendingTextComment,
} from "./assistantTextComments";
import {
  LOCAL_CHAT_HARNESS_UNAVAILABLE_MESSAGE,
  LOCAL_CHAT_UNAVAILABLE_MESSAGE,
} from "./chatHelpers";

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
  isBusy: boolean,
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

  const modelPickerDisabled =
    isBusy ||
    isActive ||
    lockedHarness ||
    !visibleHarness.available ||
    (visibleHarness.models ?? []).length === 0;
  const modelDefaultLabel = session.providerResumeId
    ? "Original model"
    : visibleHarness.default_model_id
      ? "Default model"
      : "CLI default";

  const effortPickerDisabled =
    isBusy ||
    isActive ||
    lockedHarness ||
    hasResume ||
    !visibleHarness.available ||
    reasoningEfforts.length === 0;
  const effortDefaultLabel = hasResume
    ? "Original effort"
    : visibleHarness.default_reasoning_effort
      ? "Default effort"
      : "Provider default";
  const speedPickerDisabled =
    isBusy ||
    isActive ||
    lockedHarness ||
    hasResume ||
    !visibleHarness.available;
  const speedPickerDisabledReason = isBusy
    ? "Speed tier cannot change while a request is running"
    : isActive
      ? "Speed tier cannot change during an active session"
      : lockedHarness
        ? "Speed tier cannot change for a resumed session"
        : hasResume
          ? "Speed tier cannot change while resuming"
          : !visibleHarness.available
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
  providerOptions: Array<{ info: LocalChatHarnessInfo }>;
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
  pendingComments?: readonly PendingTextComment[];
  onUpdateComment?: (id: string, body: string) => void;
  onRemoveComment?: (id: string) => void;
  onSend: (message?: string) => boolean | void;
  onStartSession: (initialPrompt?: string) => boolean | void;
  onHarnessChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  onModelChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  onReasoningEffortChange: (
    event: React.ChangeEvent<HTMLSelectElement>
  ) => void;
  onSpeedTierChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  onPermissionModeChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
}

export function ChatComposer({
  session,
  inputValue,
  setInputValue,
  inputRef,
  harnessCatalog,
  visibleHarness,
  providerOptions,
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
  const commentsAccessoryRef = useRef<HTMLDivElement | null>(null);
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
    isBusy,
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
  const hasReadyComments =
    pendingComments.length > 0 &&
    pendingComments.every((comment) => comment.body.trim().length > 0);
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
  const commentsAccessory = pendingComments.length ? (
    <div
      ref={commentsAccessoryRef}
      className="flex max-w-full flex-wrap items-center gap-1"
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
            className="relative"
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
              className="relative inline-flex h-7 w-7 items-center justify-center rounded-md border border-[var(--color-line)] bg-[var(--color-bg-1)] text-[var(--color-fg-soft)] transition-colors hover:border-[var(--color-line-strong)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
              data-testid={`local-chat-comment-icon-${commentNumber}`}
              aria-label={`Comment ${commentNumber} details`}
              aria-controls={popoverId}
              aria-expanded={isActive}
              aria-pressed={isPinned}
              title={`Click to ${isPinned ? "close" : "keep open"} comment ${commentNumber}`}
              onClick={() => {
                if (isPinned) {
                  setPinnedCommentId(null);
                  setActiveCommentId(null);
                } else {
                  setPinnedCommentId(comment.id);
                  setActiveCommentId(comment.id);
                }
              }}
            >
              <svg
                aria-hidden="true"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.8}
                viewBox="0 0 24 24"
              >
                <path d="M20.5 11.5a8.5 8.5 0 0 1-8.5 8.5 8.6 8.6 0 0 1-4-.95L3 20l.95-4.55A8.5 8.5 0 1 1 20.5 11.5Z" />
                <path d="M8 11.5h8" />
              </svg>
              <span
                aria-hidden="true"
                className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border border-[var(--color-bg)] bg-[var(--color-accent)] px-0.5 text-[9px] font-semibold leading-none text-white"
              >
                {commentNumber}
              </span>
            </button>
            {isActive ? (
              <div
                id={popoverId}
                className="absolute bottom-full left-0 z-[90] mb-2 w-96 max-w-[min(24rem,calc(100vw-2rem))] rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-bg-1)] p-3 text-left shadow-xl"
                role="group"
                aria-label={`Comment ${commentNumber} details`}
                data-testid="local-chat-comment-popover"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setPinnedCommentId(null);
                    setActiveCommentId(null);
                  }
                }}
              >
                <div className="mb-1 flex min-w-0 items-center justify-between gap-3">
                  <p className="min-w-0 flex-1 text-[11px] font-medium text-[var(--color-fg-mute)]">
                    Selected text and nearby context
                  </p>
                  <div className="flex shrink-0 items-center gap-1">
                    {isEditing ? (
                      <>
                        <button
                          type="button"
                          aria-label={`Save comment ${commentNumber}`}
                          title={`Save comment ${commentNumber}`}
                          data-testid="local-chat-save-edited-comment"
                          disabled={!editingCommentBody.trim()}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-fg-mute)] transition-colors hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                          onClick={() => {
                            onUpdateComment?.(
                              comment.id,
                              editingCommentBody.trim()
                            );
                            setEditingCommentId(null);
                          }}
                        >
                          <svg
                            aria-hidden="true"
                            className="h-4 w-4"
                            fill="none"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            viewBox="0 0 24 24"
                          >
                            <path d="m5 12.5 4.5 4.5L19 7" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          aria-label={`Cancel editing comment ${commentNumber}`}
                          title={`Cancel editing comment ${commentNumber}`}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-fg-mute)] transition-colors hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
                          onClick={() => setEditingCommentId(null)}
                        >
                          <svg
                            aria-hidden="true"
                            className="h-4 w-4"
                            fill="none"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.8}
                            viewBox="0 0 24 24"
                          >
                            <path d="m6 6 12 12M18 6 6 18" />
                          </svg>
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Edit comment ${commentNumber}`}
                        title={`Edit comment ${commentNumber}`}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-fg-mute)] transition-colors hover:bg-[var(--color-bg-4)] hover:text-[var(--color-fg)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
                        onClick={() => {
                          setEditingCommentId(comment.id);
                          setEditingCommentBody(comment.body);
                        }}
                      >
                        <svg
                          aria-hidden="true"
                          className="h-4 w-4"
                          fill="none"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.8}
                          viewBox="0 0 24 24"
                        >
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
                        </svg>
                      </button>
                    )}
                    {!isEditing ? (
                      <button
                        type="button"
                        aria-label={`Remove comment ${commentNumber}`}
                        title={`Remove comment ${commentNumber}`}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-fg-mute)] transition-colors hover:bg-[var(--color-err-wash)] hover:text-[var(--color-err)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
                        onClick={() => {
                          onRemoveComment?.(comment.id);
                          setEditingCommentId((current) =>
                            current === comment.id ? null : current
                          );
                          setPinnedCommentId(null);
                          setActiveCommentId(null);
                        }}
                      >
                        <svg
                          aria-hidden="true"
                          className="h-4 w-4"
                          fill="none"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.8}
                          viewBox="0 0 24 24"
                        >
                          <path d="M3 6h18" />
                          <path d="M8 6V4h8v2" />
                          <path d="m19 6-1 14H6L5 6" />
                          <path d="M10 11v5M14 11v5" />
                        </svg>
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="mb-2 w-full">
                  <blockquote className="max-h-24 w-full overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-[var(--color-accent)] pl-2 text-xs leading-relaxed text-[var(--color-fg-soft)]">
                    {comment.contextBefore ? (
                      <span>{comment.contextBefore}</span>
                    ) : null}
                    <mark className="bg-[var(--color-accent)]/20 text-[var(--color-fg)]">
                      {comment.quote}
                    </mark>
                    {comment.contextAfter ? (
                      <span>{comment.contextAfter}</span>
                    ) : null}
                  </blockquote>
                </div>
                {isEditing ? (
                  <textarea
                    aria-label={`Edit comment ${commentNumber}`}
                    data-testid="local-chat-comment-editor"
                    value={editingCommentBody}
                    onChange={(event) =>
                      setEditingCommentBody(event.target.value)
                    }
                    rows={2}
                    className="w-full resize-y rounded-md border border-[var(--color-line)] bg-[var(--color-bg)] p-2 text-xs text-[var(--color-fg)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
                  />
                ) : (
                  <p
                    className="whitespace-pre-wrap break-words text-xs text-[var(--color-fg)]"
                    data-testid="local-chat-comment-body"
                  >
                    {comment.body}
                  </p>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  ) : null;

  return (
    <div className="hc-foot">
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
              {harnessCatalog && (
                <label className="hc-provider-picker">
                  <select
                    aria-label="Local chat provider"
                    data-testid="local-chat-provider-picker"
                    value={session.harness}
                    onChange={onHarnessChange}
                    disabled={isBusy || isActive || lockedHarness}
                  >
                    {providerOptions.map(({ info }) => (
                      <option key={info.harness} value={info.harness}>
                        {info.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="hc-permission-picker">
                <select
                  aria-label="Local chat permission mode"
                  data-testid="local-chat-permission-mode-picker"
                  value={session.permissionMode ?? "default"}
                  onChange={onPermissionModeChange}
                  disabled={isBusy || isActive}
                >
                  {availablePermissionModes.map((mode) => (
                    <option key={mode.value} value={mode.value}>
                      {mode.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          }
          footerRight={
            visibleHarness && picker ? (
              <div className="hc-chat-controls right">
                <label className="hc-model-picker">
                  <select
                    aria-label={`${visibleHarness.label} model`}
                    data-testid="local-chat-model-picker"
                    value={session.selectedModelId ?? ""}
                    onChange={onModelChange}
                    disabled={picker.modelPickerDisabled}
                  >
                    <option value="">{picker.modelDefaultLabel}</option>
                    {picker.selectedModelUnsupported && (
                      <option value={session.selectedModelId ?? ""}>
                        Unsupported: {session.selectedModelId}
                      </option>
                    )}
                    {(visibleHarness.models ?? []).map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                        {model.id === visibleHarness.default_model_id
                          ? " (default)"
                          : ""}
                      </option>
                    ))}
                  </select>
                </label>
                {availableReasoningEfforts.length > 0 && (
                  <label className="hc-effort-picker">
                    <select
                      aria-label={`${visibleHarness.label} reasoning effort`}
                      data-testid="local-chat-effort-picker"
                      value={session.selectedReasoningEffort ?? ""}
                      onChange={onReasoningEffortChange}
                      disabled={picker.effortPickerDisabled}
                    >
                      <option value="">{picker.effortDefaultLabel}</option>
                      {picker.selectedReasoningEffortUnsupported && (
                        <option value={session.selectedReasoningEffort ?? ""}>
                          Unsupported: {session.selectedReasoningEffort}
                        </option>
                      )}
                      {availableReasoningEfforts.map((effort) => (
                        <option key={effort.id} value={effort.id}>
                          {effort.label}
                          {effort.id === visibleHarness.default_reasoning_effort
                            ? " (default)"
                            : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {(speedTiers.length > 1 ||
                  picker.selectedSpeedTierUnsupported) && (
                  <label
                    className="hc-speed-picker"
                    title={picker.speedPickerDisabledReason}
                  >
                    <select
                      aria-label={`${visibleHarness.label} speed tier`}
                      data-testid="local-chat-speed-tier-picker"
                      value={session.selectedSpeedTier ?? defaultSpeedTierId}
                      onChange={onSpeedTierChange}
                      disabled={picker.speedPickerDisabled}
                    >
                      {picker.selectedSpeedTierUnsupported && (
                        <option value={session.selectedSpeedTier ?? ""}>
                          Unsupported: {session.selectedSpeedTier}
                        </option>
                      )}
                      {speedTiers.map((tier) => (
                        <option key={tier.id} value={tier.id}>
                          {tier.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {picker.unavailableMessage && (
                  <span
                    className="hc-provider-unavailable"
                    data-testid="local-chat-provider-unavailable"
                  >
                    {picker.unavailableMessage}
                  </span>
                )}
              </div>
            ) : null
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
