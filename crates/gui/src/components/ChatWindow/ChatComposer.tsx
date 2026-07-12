import { ChatInput } from "../ChatInput";
import { formatTokenCount } from "../../utils/modelContextWindow";
import type {
  LocalChatHarnessCatalog,
  LocalChatHarnessInfo,
  PermissionMode,
} from "../../bindings";
import type { ChatSession } from "../../stores/chatStore";
import { harnessDisplayName } from "./chatHelpers";

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

function permissionModeOptions(harness: ChatSession["harness"]) {
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
  supportedModelIds: Set<string>,
  reasoningEfforts: LocalChatHarnessInfo["reasoning_efforts"],
  supportedReasoningEffortIds: Set<string>
) {
  if (!visibleHarness) return null;

  const selectedModelUnsupported =
    !!session.selectedModelId &&
    !supportedModelIds.has(session.selectedModelId);
  const selectedReasoningEffortUnsupported =
    !!session.selectedReasoningEffort &&
    !supportedReasoningEffortIds.has(session.selectedReasoningEffort);

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

  const unavailableReason = !visibleHarness.available
    ? (visibleHarness.unavailable_reason ??
      `${visibleHarness.label} is unavailable`)
    : null;

  return {
    selectedModelUnsupported,
    selectedReasoningEffortUnsupported,
    modelPickerDisabled,
    modelDefaultLabel,
    effortPickerDisabled,
    effortDefaultLabel,
    unavailableReason,
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
    info: LocalChatHarnessInfo;
    disabled: boolean;
  }>;
  supportedModelIds: Set<string>;
  reasoningEfforts?: LocalChatHarnessInfo["reasoning_efforts"];
  supportedReasoningEffortIds: Set<string>;
  isBusy: boolean;
  isActive: boolean;
  lockedHarness: boolean;
  hasResume: boolean;
  canUseComposer: boolean;
  canSendMessage: boolean;
  shouldStartOrResume: boolean;
  submitLabel: string;
  composerPlaceholder: string;
  ctxPct: number;
  ctxColor: string;
  usage: { used: number; max: number } | null;
  onSend: () => void;
  onStartSession: () => void;
  onHarnessChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  onModelChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  onReasoningEffortChange: (
    event: React.ChangeEvent<HTMLSelectElement>
  ) => void;
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
  isBusy,
  isActive,
  lockedHarness,
  hasResume,
  canUseComposer,
  canSendMessage,
  shouldStartOrResume,
  submitLabel,
  composerPlaceholder,
  ctxPct,
  ctxColor,
  usage,
  onSend,
  onStartSession,
  onHarnessChange,
  onModelChange,
  onReasoningEffortChange,
  onPermissionModeChange,
}: ChatComposerProps) {
  const availableReasoningEfforts =
    reasoningEfforts ?? visibleHarness?.reasoning_efforts ?? [];
  const picker = useHarnessPickerState(
    visibleHarness,
    session,
    isBusy,
    isActive,
    lockedHarness,
    hasResume,
    supportedModelIds,
    availableReasoningEfforts,
    supportedReasoningEffortIds
  );

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
                  <span>Provider</span>
                  <select
                    aria-label="Local chat provider"
                    data-testid="local-chat-provider-picker"
                    value={session.harness}
                    onChange={onHarnessChange}
                    disabled={isBusy || isActive || lockedHarness}
                  >
                    {providerOptions.map(({ info, disabled }) => (
                      <option
                        key={info.harness}
                        value={info.harness}
                        disabled={disabled}
                      >
                        {info.available
                          ? info.label
                          : `${info.label}: ${
                              info.unavailable_reason ?? "Unavailable"
                            }`}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="hc-permission-picker">
                <span>Permission</span>
                <select
                  aria-label="Local chat permission mode"
                  data-testid="local-chat-permission-mode-picker"
                  value={session.permissionMode ?? "default"}
                  onChange={onPermissionModeChange}
                  disabled={isBusy || isActive}
                >
                  {permissionModeOptions(session.harness).map((mode) => (
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
                  <span>Model</span>
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
                    <span>Effort</span>
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
                {picker.unavailableReason && (
                  <span
                    className="hc-provider-unavailable"
                    data-testid="local-chat-provider-unavailable"
                  >
                    {harnessDisplayName(visibleHarness.harness)} unavailable:{" "}
                    {picker.unavailableReason}
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
            title={`${usage.used.toLocaleString()} / ${usage.max.toLocaleString()} current request input context tokens`}
          >
            context <b>{ctxPct}%</b>
            {session.model
              ? ` · ${session.model.replace(/^claude-/i, "")} · ${formatTokenCount(usage.used)}/${formatTokenCount(usage.max)}`
              : ""}
          </span>
        ) : (
          <span className="ctx-lbl">&nbsp;</span>
        )}
      </div>
    </div>
  );
}
