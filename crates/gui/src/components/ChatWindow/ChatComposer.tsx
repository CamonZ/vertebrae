import { ChatInput } from "../ChatInput";
import { formatTokenCount } from "../../utils/modelContextWindow";
import type {
  LocalChatHarnessCatalog,
  LocalChatHarnessInfo,
  PermissionMode,
} from "../../bindings";
import type { ChatSession } from "../../stores/chatStore";
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
  onSend: () => void;
  onStartSession: () => void;
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
  onSend,
  onStartSession,
  onHarnessChange,
  onModelChange,
  onReasoningEffortChange,
  onSpeedTierChange,
  onPermissionModeChange,
}: ChatComposerProps) {
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
          onSubmit={canSendMessage ? onSend : onStartSession}
          disabled={!canUseComposer}
          canSubmit={
            canUseComposer &&
            inputValue.trim().length > 0 &&
            (canSendMessage || shouldStartOrResume)
          }
          placeholder={composerPlaceholder}
          buttonTitle={submitLabel}
          buttonAriaLabel={submitLabel}
          textareaTestId="local-chat-composer"
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
                          {tier.label}{tier.is_default ? " (default)" : ""}
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
