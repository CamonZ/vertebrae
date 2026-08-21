import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  commands,
  type LocalChatHarnessCatalog,
  type LocalChatHarnessInfo,
  type LocalChatHarnessKind,
  type LocalFileEditor,
  type PermissionMode,
} from "../bindings";
import { Icon } from "../components/atoms/Icon";
import { Badge } from "../components/atoms/Badge";
import { Button } from "../components/atoms/Button";
import { Modal } from "../components/molecules/Modal";
import { Select } from "../components/atoms/Select";
import {
  GUI_UPDATE_CHANNELS,
  GUI_UPDATE_CHANNEL,
  selectGuiUpdateChannel,
  useGuiUpdateStore,
  type GuiUpdateChannel,
  type GuiUpdateComponentInfo,
  type GuiUpdateComponentKey,
  type GuiUpdateInfo,
  type GuiUpdateApplyState,
  type GuiUpdateState,
  type LocalBackendUpdateApplyState,
  type LocalBackendUpdateInfo,
} from "../stores/guiUpdateStore";
import {
  applyApprovedGuiUpdate,
  applyApprovedLocalBackendUpdate,
  relaunchGuiApplication,
} from "../update";
import { useUIStore } from "../stores/uiStore";
import {
  hasStaleModelDefault,
  hasStalePermissionDefault,
  hasStaleReasoningEffort,
  resolveDefaultHarness,
  resolveModelDefaultId,
  resolvePermissionDefault,
  resolveReasoningEffortDefault,
  useLocalChatDefaultsStore,
} from "../utils/localChatDefaults";

function modelLabel(
  info: LocalChatHarnessInfo,
  modelId: string | null
): string {
  if (!modelId) return "Provider default";
  return info.models.find((model) => model.id === modelId)?.label ?? modelId;
}

function permissionLabel(
  info: LocalChatHarnessInfo,
  permissionMode: PermissionMode | null
): string {
  if (!permissionMode) return "Provider default";
  return (
    info.permission_modes?.find((mode) => mode.id === permissionMode)?.label ??
    permissionMode
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(220px,320px)] sm:items-center sm:gap-8">
      <div>
        <p className="text-sm font-medium text-[var(--color-fg)]">{label}</p>
        <p className="mt-1 text-sm leading-5 text-[var(--color-fg-soft)]">
          {description}
        </p>
      </div>
      <div>{children}</div>
    </div>
  );
}

function SaveIndicator({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-[var(--color-ok)]"
      data-testid="settings-saved-indicator"
      role="status"
    >
      <Icon
        size="sm"
        label="Saved"
        className="animate-fade-in-up"
        data-testid="settings-saved-icon"
      >
        <path d="m5 12 4 4L19 6" />
      </Icon>
      Saved
    </span>
  );
}

function HarnessDefaultsSection({
  info,
  onSaved,
}: {
  info: LocalChatHarnessInfo;
  onSaved: () => void;
}) {
  const saved = useLocalChatDefaultsStore(
    (state) => state.defaults[info.harness]
  );
  const setModelDefault = useLocalChatDefaultsStore(
    (state) => state.setModelDefault
  );
  const setReasoningEffortDefault = useLocalChatDefaultsStore(
    (state) => state.setReasoningEffortDefault
  );
  const setPermissionDefault = useLocalChatDefaultsStore(
    (state) => state.setPermissionDefault
  );
  const resetHarness = useLocalChatDefaultsStore((state) => state.resetHarness);
  const permissionModes = info.permission_modes ?? [];
  const effectiveModelId = resolveModelDefaultId(info, saved?.modelId);
  const effectivePermissionMode = resolvePermissionDefault(
    info,
    saved?.permissionMode
  );
  const reasoningEfforts = useMemo(() => {
    const selectedModel = info.models.find(
      (model) => model.id === effectiveModelId
    );
    const supportedIds = selectedModel?.supported_reasoning_effort_ids;
    if (!supportedIds) return info.reasoning_efforts;
    const supported = new Set(supportedIds);
    return info.reasoning_efforts.filter((effort) => supported.has(effort.id));
  }, [effectiveModelId, info]);
  const effectiveReasoningEffort = resolveReasoningEffortDefault(
    info,
    saved?.reasoningEffort,
    effectiveModelId
  );
  const staleModel = hasStaleModelDefault(info, saved?.modelId);
  const stalePermission = hasStalePermissionDefault(
    info,
    saved?.permissionMode
  );
  const staleReasoningEffort = hasStaleReasoningEffort(
    info,
    saved?.reasoningEffort,
    effectiveModelId
  );
  const hasSavedOverride =
    !!saved?.modelId || !!saved?.reasoningEffort || !!saved?.permissionMode;

  return (
    <section
      className="border-t border-[var(--color-line)]"
      data-testid={`harness-defaults-${info.harness}`}
    >
      <div className="flex items-center justify-between gap-4 pt-7">
        <div className="flex items-center gap-2">
          <h2 className="font-serif text-xl text-[var(--color-fg)]">
            {info.label}
          </h2>
          <span
            className={`rounded-full px-2 py-0.5 font-mono text-[length:var(--text-9)] uppercase tracking-[0.08em] ${
              info.available
                ? "bg-[var(--color-ok-wash)] text-[var(--color-ok)]"
                : "bg-[var(--color-warn-wash)] text-[var(--color-warn)]"
            }`}
          >
            {info.available ? "Available" : "Unavailable"}
          </span>
        </div>
        {hasSavedOverride && (
          <button
            type="button"
            onClick={() => {
              resetHarness(info.harness);
              onSaved();
            }}
            className="shrink-0 text-xs font-medium text-[var(--color-accent)] hover:underline"
            data-testid={`reset-harness-defaults-${info.harness}`}
          >
            Reset
          </button>
        )}
      </div>
      <p className="mt-1 max-w-2xl text-sm leading-5 text-[var(--color-fg-soft)]">
        Defaults for new {info.label} chats. Running and resumed sessions keep
        their existing configuration.
      </p>

      {!info.available && info.unavailable_reason && (
        <p
          className="mt-4 rounded-[var(--radius-md)] border border-[var(--color-warn)]/30 bg-[var(--color-warn-wash)] px-3 py-2 text-xs text-[var(--color-warn)]"
          data-testid={`harness-unavailable-${info.harness}`}
        >
          {info.unavailable_reason}
        </p>
      )}

      <div className="mt-4 divide-y divide-[var(--color-line)]">
        <SettingRow
          label="Default model"
          description="Used when a new chat does not choose a model."
        >
          <Select
            aria-label={`${info.label} default model`}
            data-testid={`${info.harness}-default-model`}
            value={saved?.modelId ?? ""}
            onChange={(event) => {
              setModelDefault(info.harness, event.target.value || null);
              onSaved();
            }}
            disabled={!info.available || info.models.length === 0}
            options={[
              {
                value: "",
                label: `Provider default${
                  effectiveModelId
                    ? ` (${modelLabel(info, effectiveModelId)})`
                    : ""
                }`,
              },
              ...(staleModel
                ? [
                    {
                      value: saved?.modelId ?? "",
                      label: `Unavailable: ${saved?.modelId}`,
                    },
                  ]
                : []),
              ...info.models.map((model) => ({
                value: model.id,
                label: `${model.label}${
                  model.id === info.default_model_id ? " (harness default)" : ""
                }`,
              })),
            ]}
          />
          {staleModel && (
            <p className="mt-1 text-xs text-[var(--color-warn)]">
              Saved model is unavailable; new chats use{" "}
              {modelLabel(info, effectiveModelId)}.
            </p>
          )}
        </SettingRow>

        {info.reasoning_efforts.length > 0 && (
          <SettingRow
            label="Reasoning effort"
            description="Controls how much reasoning a new chat can use."
          >
            <Select
              aria-label={`${info.label} reasoning effort`}
              data-testid={`${info.harness}-default-reasoning-effort`}
              value={saved?.reasoningEffort ?? ""}
              onChange={(event) => {
                setReasoningEffortDefault(
                  info.harness,
                  event.target.value || null
                );
                onSaved();
              }}
              disabled={!info.available || reasoningEfforts.length === 0}
              options={[
                {
                  value: "",
                  label: `Provider default${
                    effectiveReasoningEffort
                      ? ` (${reasoningEfforts.find((effort) => effort.id === effectiveReasoningEffort)?.label ?? effectiveReasoningEffort})`
                      : ""
                  }`,
                },
                ...(staleReasoningEffort
                  ? [
                      {
                        value: saved?.reasoningEffort ?? "",
                        label: `Unavailable: ${saved?.reasoningEffort}`,
                      },
                    ]
                  : []),
                ...reasoningEfforts.map((effort) => ({
                  value: effort.id,
                  label: `${effort.label}${
                    effort.id === info.default_reasoning_effort
                      ? " (harness default)"
                      : ""
                  }`,
                })),
              ]}
            />
            {staleReasoningEffort && (
              <p className="mt-1 text-xs text-[var(--color-warn)]">
                Saved effort is unavailable for the selected model; new chats
                use the provider default.
              </p>
            )}
          </SettingRow>
        )}

        <SettingRow
          label="Permission policy"
          description="Controls how tool and file-change requests are handled."
        >
          <Select
            aria-label={`${info.label} default permission`}
            data-testid={`${info.harness}-default-permission`}
            value={saved?.permissionMode ?? ""}
            onChange={(event) => {
              setPermissionDefault(
                info.harness,
                (event.target.value || null) as PermissionMode | null
              );
              onSaved();
            }}
            disabled={!info.available || permissionModes.length === 0}
            options={[
              {
                value: "",
                label: `Provider default${
                  effectivePermissionMode
                    ? ` (${permissionLabel(info, effectivePermissionMode)})`
                    : ""
                }`,
              },
              ...(stalePermission
                ? [
                    {
                      value: saved?.permissionMode ?? "",
                      label: `Unavailable: ${saved?.permissionMode}`,
                    },
                  ]
                : []),
              ...permissionModes.map((mode) => ({
                value: mode.id,
                label: `${mode.label}${
                  mode.is_default ? " (harness default)" : ""
                }`,
              })),
            ]}
          />
          {stalePermission && (
            <p className="mt-1 text-xs text-[var(--color-warn)]">
              Saved policy is unavailable; new chats use{" "}
              {permissionLabel(info, effectivePermissionMode)}.
            </p>
          )}
        </SettingRow>
      </div>
    </section>
  );
}

const UPDATE_COMPONENTS: ReadonlyArray<{
  key: GuiUpdateComponentKey;
  label: string;
  aliases: string[];
}> = [
  { key: "gui", label: "Vertebrae GUI", aliases: ["gui", "vertebrae gui"] },
  { key: "cli", label: "vtb CLI", aliases: ["cli", "vtb", "vtb cli"] },
  {
    key: "daemon",
    label: "vtb-daemon",
    aliases: ["daemon", "vtb-daemon"],
  },
  { key: "gate", label: "vtb-gate", aliases: ["gate", "vtb-gate"] },
];

const NOT_PROVIDED = "Not provided";

function releaseNotes(update: GuiUpdateInfo): string | null {
  const notes = update.releaseNotes ?? update.notes;
  return notes && notes.trim().length > 0 ? notes : null;
}

function publicationDate(update: GuiUpdateInfo): string | null {
  return update.date ?? update.publishedAt ?? update.published_at ?? null;
}

function componentInfo(
  update: GuiUpdateInfo,
  key: GuiUpdateComponentKey,
  aliases: string[]
): GuiUpdateComponentInfo | undefined {
  const components = update.components;
  if (!components) return undefined;
  if (Array.isArray(components)) {
    const accepted = new Set(aliases.map((alias) => alias.toLowerCase()));
    return components.find((component) =>
      [component.key, component.name]
        .filter((value): value is string => Boolean(value))
        .some((value) => accepted.has(value.toLowerCase()))
    );
  }
  return components[key];
}

function componentRow(
  update: GuiUpdateInfo,
  item: (typeof UPDATE_COMPONENTS)[number]
) {
  const info = componentInfo(update, item.key, item.aliases);
  const currentVersion =
    info?.currentVersion ??
    info?.current_version ??
    (item.key === "gui" ? update.currentVersion : NOT_PROVIDED);
  const targetVersion =
    info?.targetVersion ??
    info?.target_version ??
    info?.version ??
    update.version;
  const status = info?.status
    ? formatUpdateStatus(info.status)
    : info
      ? "Ready"
      : "Metadata unavailable";

  return { currentVersion, info, status, targetVersion };
}

function formatUpdateStatus(status: string): string {
  return status
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function hasAvailableUpdate(state: GuiUpdateState): boolean {
  return (
    state.available !== null &&
    state.status !== "current" &&
    state.status !== "unavailable"
  );
}

function channelLabel(channel: GuiUpdateChannel): string {
  return channel === "master" ? "master (edge)" : "release (stable)";
}

function channelStateFor(state: GuiUpdateState, channel: GuiUpdateChannel) {
  const channelState = state.channels[channel];
  // Keep Settings fixtures and older persisted state useful while the first
  // multi-channel check has not populated the per-channel map yet.
  if (
    channel === state.selectedChannel &&
    state.available &&
    state.status !== "unavailable"
  ) {
    return {
      ...channelState,
      available: true,
      update: state.available,
      currentVersion: state.currentVersion,
    };
  }
  return channelState;
}

function UpdateChannelSelector({ state }: { state: GuiUpdateState }) {
  const selectedChannel = state.selectedChannel ?? GUI_UPDATE_CHANNEL;
  const selectedState = channelStateFor(state, selectedChannel);

  return (
    <div
      className="mt-8 border-y border-[var(--color-line)]"
      data-testid="settings-update-channel-selector"
    >
      <SettingRow
        label="Update channel"
        description="Choose which signed release stream Vertebrae should show. A channel is selectable only when its release metadata can be verified."
      >
        <Select
          aria-label="Update channel"
          data-testid="settings-update-channel"
          value={selectedChannel}
          onChange={(event) =>
            selectGuiUpdateChannel(event.target.value as GuiUpdateChannel)
          }
          options={GUI_UPDATE_CHANNELS.map((channel) => {
            const channelState = channelStateFor(state, channel);
            return {
              value: channel,
              label: channelState.available
                ? channelLabel(channel)
                : `${channelLabel(channel)} (unavailable)`,
              disabled: !channelState.available,
            };
          })}
        />
        {!selectedState.available && selectedState.error && (
          <p
            className="mt-2 text-xs text-[var(--color-warn)]"
            data-testid="settings-update-channel-unavailable"
            role="status"
          >
            {channelLabel(selectedChannel)} is unavailable:{" "}
            {selectedState.error}
          </p>
        )}
      </SettingRow>
    </div>
  );
}

function UpdateStateMessage({
  children,
  intent,
  testId,
}: {
  children: ReactNode;
  intent: "status" | "alert";
  testId: string;
}) {
  return (
    <div
      className={[
        "mt-8 rounded-[var(--radius-md)] border p-5 text-sm",
        intent === "alert"
          ? "border-[var(--color-err)]/30 bg-[var(--color-err-wash)] text-[var(--color-err)]"
          : "border-dashed border-[var(--color-line-strong)] text-[var(--color-fg-mute)]",
      ].join(" ")}
      data-testid={testId}
      role={intent === "alert" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}

function UpdateApplyStatus({ apply }: { apply: GuiUpdateApplyState }) {
  if (apply.status === "idle") return null;
  if (apply.status === "applying") {
    return (
      <UpdateStateMessage intent="status" testId="settings-update-applying">
        Applying the approved signed release. Components are being downloaded,
        verified, and activated in order…
      </UpdateStateMessage>
    );
  }
  if (apply.status === "error") {
    return (
      <UpdateStateMessage intent="alert" testId="settings-update-apply-error">
        The update could not be applied: {apply.message}
      </UpdateStateMessage>
    );
  }

  const result = apply.result;
  if (!result) return null;
  const failed =
    apply.status === "partial_failure" || apply.status === "retryable_failure";
  const relaunchAvailable =
    !failed && result.state === "deferred_relaunch" && !result.restart_forced;

  return (
    <section
      className="mt-8 rounded-[var(--radius-md)] border border-[var(--color-line-strong)] bg-[var(--color-bg-1)] p-5"
      data-testid={
        failed
          ? apply.status === "retryable_failure"
            ? "settings-update-retry"
            : "settings-update-partial-failure"
          : "settings-update-result"
      }
      role={failed ? "alert" : "status"}
    >
      <p className="font-mono text-xs uppercase tracking-[0.14em] text-[var(--color-fg-mute)]">
        {failed ? "Update needs attention" : "Update complete"}
      </p>
      <p className="mt-2 text-sm leading-6 text-[var(--color-fg-soft)]">
        {failed
          ? (result.recovery_action ??
            "The previous active components were preserved. You can retry after correcting the release.")
          : "The approved release was applied without forcing a restart."}
      </p>
      <ul
        className="mt-4 divide-y divide-[var(--color-line)] rounded-[var(--radius-sm)] border border-[var(--color-line)]"
        data-testid="settings-update-progress"
      >
        {result.progress.map((component) => (
          <li
            className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
            key={component.component}
          >
            <span className="font-mono text-[var(--color-fg)]">
              {component.component}
            </span>
            <span className="text-right text-[var(--color-fg-mute)]">
              {component.state.replace(/_/g, " ")} — {component.message}
            </span>
          </li>
        ))}
      </ul>
      {relaunchAvailable && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-line)] pt-4">
          <span className="text-xs text-[var(--color-fg-mute)]">
            The new GUI will take effect after a relaunch.
          </span>
          <Button
            variant="secondary"
            data-testid="settings-update-relaunch"
            onClick={() => {
              void relaunchGuiApplication();
            }}
          >
            Relaunch GUI
          </Button>
        </div>
      )}
    </section>
  );
}

function imageDigest(imageRef: string): string {
  const digest = imageRef.split("@sha256:")[1];
  return digest ? `sha256:${digest.slice(0, 12)}…` : imageRef;
}

function LocalBackendUpdateApplyStatus({
  apply,
}: {
  apply: LocalBackendUpdateApplyState;
}) {
  if (apply.status === "idle") return null;
  if (apply.status === "applying") {
    return (
      <UpdateStateMessage
        intent="status"
        testId="settings-local-backend-update-applying"
      >
        Applying the approved local backend update. Existing backend data will
        be preserved.
      </UpdateStateMessage>
    );
  }
  if (apply.status === "error") {
    return (
      <UpdateStateMessage
        intent="alert"
        testId="settings-local-backend-update-error"
      >
        The local backend update could not be applied: {apply.message}
      </UpdateStateMessage>
    );
  }

  return (
    <UpdateStateMessage
      intent="status"
      testId="settings-local-backend-update-result"
    >
      The local backend was updated to {apply.result.version} (
      {apply.result.build}).
    </UpdateStateMessage>
  );
}

function ReviewLocalBackendUpdateDialog({
  update,
  onApprove,
  onClose,
}: {
  update: LocalBackendUpdateInfo;
  onApprove: (update: LocalBackendUpdateInfo) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title="Review local backend update"
      variant="sheet"
      className="max-w-[calc(100vw-2rem)]"
    >
      <div className="space-y-5">
        <p className="text-sm leading-6 text-[var(--color-fg-soft)]">
          Review the verified local backend release before approving it. No
          Docker image will be downloaded or restarted until you approve.
        </p>
        <dl className="grid gap-3 rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-bg-1)] p-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-[var(--color-fg-mute)]">Channel</dt>
            <dd className="mt-1 text-sm text-[var(--color-fg)]">
              {channelLabel(update.channel)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-fg-mute)]">
              Target version
            </dt>
            <dd className="mt-1 font-mono text-sm text-[var(--color-fg)]">
              {update.version}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-fg-mute)]">Build</dt>
            <dd className="mt-1 font-mono text-sm text-[var(--color-fg)]">
              {update.build}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-fg-mute)]">
              Image digest
            </dt>
            <dd className="mt-1 font-mono text-sm text-[var(--color-fg)]">
              {imageDigest(update.imageRef)}
            </dd>
          </div>
        </dl>
        <div className="flex flex-col-reverse gap-2 border-t border-[var(--color-line)] pt-4 sm:flex-row sm:justify-end">
          <Button
            variant="ghost"
            onClick={onClose}
            data-testid="settings-review-local-backend-update-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onApprove(update);
              onClose();
            }}
            data-testid="settings-review-local-backend-update-approve"
          >
            Approve backend update
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function LocalBackendUpdateSection({
  update,
  onReview,
}: {
  update: LocalBackendUpdateInfo;
  onReview: () => void;
}) {
  return (
    <article
      className="mt-7 rounded-[var(--radius-lg)] border border-[var(--color-line-strong)] bg-[var(--color-bg-1)] p-5 sm:p-6"
      data-testid="settings-local-backend-update-card"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.14em] text-[var(--color-accent)]">
            Local backend update available
          </p>
          <h2 className="mt-2 font-serif text-2xl text-[var(--color-fg)]">
            Backend {update.version}
          </h2>
        </div>
        <Button
          variant="primary"
          onClick={onReview}
          data-testid="settings-review-local-backend-update"
        >
          Review backend update
        </Button>
      </div>
      <dl className="mt-6 grid gap-4 border-y border-[var(--color-line)] py-4 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-[var(--color-fg-mute)]">Channel</dt>
          <dd className="mt-1 text-sm text-[var(--color-fg)]">
            {channelLabel(update.channel)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--color-fg-mute)]">Current image</dt>
          <dd className="mt-1 font-mono text-sm text-[var(--color-fg)]">
            {imageDigest(update.currentImageRef)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--color-fg-mute)]">Build</dt>
          <dd className="mt-1 font-mono text-sm text-[var(--color-fg)]">
            {update.build}
          </dd>
        </div>
      </dl>
    </article>
  );
}

function UpdateComponents({ update }: { update: GuiUpdateInfo }) {
  return (
    <section
      className="mt-7 border-t border-[var(--color-line)] pt-5"
      aria-labelledby="settings-update-components-heading"
      data-testid="settings-update-components"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3
          id="settings-update-components-heading"
          className="font-mono text-xs uppercase tracking-[0.14em] text-[var(--color-fg-mute)]"
        >
          Components
        </h3>
        <span className="text-xs text-[var(--color-fg-mute)]">
          Current → target
        </span>
      </div>
      <ul className="mt-3 divide-y divide-[var(--color-line)] rounded-[var(--radius-md)] border border-[var(--color-line)]">
        {UPDATE_COMPONENTS.map((item) => {
          const row = componentRow(update, item);
          return (
            <li
              key={item.key}
              className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:gap-5"
              data-testid={`settings-update-component-${item.key}`}
            >
              <span className="font-medium text-[var(--color-fg)]">
                {item.label}
              </span>
              <span className="font-mono text-xs text-[var(--color-fg-soft)]">
                {row.currentVersion} → {row.targetVersion}
              </span>
              <span className="text-xs text-[var(--color-fg-mute)]">
                {row.status}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ReviewUpdateDialog({
  update,
  stale,
  onApprove,
  onClose,
}: {
  update: GuiUpdateInfo;
  stale: boolean;
  onApprove?: (update: GuiUpdateInfo) => void;
  onClose: () => void;
}) {
  const verification = update.verification;
  const hasComponentMetadata = Boolean(
    update.components &&
    (Array.isArray(update.components)
      ? update.components.length > 0
      : Object.keys(update.components).length > 0)
  );

  return (
    <Modal
      open
      onClose={onClose}
      title="Review update"
      variant="sheet"
      className="max-w-[calc(100vw-2rem)]"
    >
      <div className="space-y-5">
        <div>
          <p className="text-sm leading-6 text-[var(--color-fg-soft)]">
            Review the verified release before approving it. This screen does
            not download, install, restart, or relaunch anything.
          </p>
          {stale && (
            <p
              className="mt-3 rounded-[var(--radius-md)] border border-[var(--color-warn)]/30 bg-[var(--color-warn-wash)] px-3 py-2 text-xs text-[var(--color-warn)]"
              data-testid="settings-review-stale"
              role="status"
            >
              The last check failed. These details are from the last verified
              release and may need to be checked again before applying.
            </p>
          )}
        </div>

        <dl className="grid gap-3 rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-bg-1)] p-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-[var(--color-fg-mute)]">
              Current version
            </dt>
            <dd className="mt-1 font-mono text-sm text-[var(--color-fg)]">
              {update.currentVersion}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-fg-mute)]">
              Target version
            </dt>
            <dd className="mt-1 font-mono text-sm text-[var(--color-fg)]">
              {update.version}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-fg-mute)]">Channel</dt>
            <dd className="mt-1 text-sm text-[var(--color-fg)]">
              {update.channel ?? GUI_UPDATE_CHANNEL}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-fg-mute)]">Build</dt>
            <dd className="mt-1 font-mono text-sm text-[var(--color-fg)]">
              {update.build ?? NOT_PROVIDED}
            </dd>
          </div>
        </dl>

        <section
          className="border-t border-[var(--color-line)] pt-5"
          aria-labelledby="settings-update-preflight-heading"
        >
          <h3
            id="settings-update-preflight-heading"
            className="font-mono text-xs uppercase tracking-[0.14em] text-[var(--color-fg-mute)]"
          >
            Preflight and verification
          </h3>
          <dl className="mt-3 divide-y divide-[var(--color-line)] rounded-[var(--radius-md)] border border-[var(--color-line)]">
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <dt className="text-sm text-[var(--color-fg-soft)]">Signature</dt>
              <dd className="text-right text-sm text-[var(--color-ok)]">
                {verification?.signature ??
                  "Verified by signed updater metadata"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <dt className="text-sm text-[var(--color-fg-soft)]">Preflight</dt>
              <dd className="text-right text-sm text-[var(--color-ok)]">
                {verification?.preflight ?? "Ready for review"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <dt className="text-sm text-[var(--color-fg-soft)]">
                Compatibility
              </dt>
              <dd className="text-right text-sm text-[var(--color-fg)]">
                {verification?.compatibility ?? "Not provided"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <dt className="text-sm text-[var(--color-fg-soft)]">
                Component metadata
              </dt>
              <dd className="text-right text-sm text-[var(--color-fg)]">
                {verification?.componentManifest ??
                  (hasComponentMetadata ? "Available" : "Not available")}
              </dd>
            </div>
          </dl>
        </section>

        <div className="flex flex-col-reverse gap-2 border-t border-[var(--color-line)] pt-4 sm:flex-row sm:justify-end">
          <Button
            variant="ghost"
            onClick={onClose}
            data-testid="settings-review-update-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onApprove?.(update);
              onClose();
            }}
            data-testid="settings-review-update-approve"
          >
            Approve update
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function BackendCurrentDetails({ state }: { state: GuiUpdateState }) {
  const backend = state.localBackend;
  return (
    <dl
      className="mt-5 grid gap-4 rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-bg-1)] p-4 sm:grid-cols-3"
      data-testid="settings-backend-current"
    >
      <div>
        <dt className="text-xs text-[var(--color-fg-mute)]">Current version</dt>
        <dd className="mt-1 font-mono text-sm text-[var(--color-fg)]">
          {backend.currentVersion ?? NOT_PROVIDED}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-[var(--color-fg-mute)]">Build</dt>
        <dd className="mt-1 font-mono text-sm text-[var(--color-fg)]">
          {backend.currentBuild ?? NOT_PROVIDED}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-[var(--color-fg-mute)]">Image</dt>
        <dd className="mt-1 font-mono text-sm text-[var(--color-fg)]">
          {backend.currentImageRef
            ? imageDigest(backend.currentImageRef)
            : NOT_PROVIDED}
        </dd>
      </div>
    </dl>
  );
}

function FrontendUpdatesSection({
  state,
  onReview,
}: {
  state: GuiUpdateState;
  onReview: () => void;
}) {
  const update = state.available;
  const showRelease = update !== null && hasAvailableUpdate(state);
  const stale = state.status === "error" || state.status === "stale";
  const notes = update ? releaseNotes(update) : null;
  const apply = state.apply ?? { status: "idle" as const };

  return (
    <section
      data-testid="settings-frontend-updates"
      aria-labelledby="settings-frontend-updates-heading"
    >
      <h2
        id="settings-frontend-updates-heading"
        className="font-serif text-2xl text-[var(--color-fg)]"
      >
        Frontend
      </h2>
      <dl
        className="mt-5 grid gap-4 rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-bg-1)] p-4 sm:grid-cols-2"
        data-testid="settings-frontend-current"
      >
        <div>
          <dt className="text-xs text-[var(--color-fg-mute)]">
            Current version
          </dt>
          <dd className="mt-1 font-mono text-sm text-[var(--color-fg)]">
            {state.currentVersion ?? NOT_PROVIDED}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--color-fg-mute)]">Channel</dt>
          <dd className="mt-1 text-sm text-[var(--color-fg)]">
            {channelLabel(state.selectedChannel ?? GUI_UPDATE_CHANNEL)}
          </dd>
        </div>
      </dl>

      {apply.status !== "idle" && <UpdateApplyStatus apply={apply} />}
      {showRelease && update ? (
        <div className="mt-6" data-testid="settings-updates-available">
          {stale && (
            <p
              className="mb-4 rounded-[var(--radius-md)] border border-[var(--color-warn)]/30 bg-[var(--color-warn-wash)] px-3 py-2 text-xs text-[var(--color-warn)]"
              data-testid="settings-updates-stale"
              role="status"
            >
              The last check failed. Showing the last verified release.
            </p>
          )}
          {state.checking && (
            <p
              className="mb-4 text-xs text-[var(--color-fg-mute)]"
              data-testid="settings-updates-checking"
              role="status"
            >
              Checking for a newer signed release…
            </p>
          )}
          <article
            className="rounded-[var(--radius-lg)] border border-[var(--color-line-strong)] bg-[var(--color-bg-1)] p-5 sm:p-6"
            data-testid="settings-update-card"
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="font-mono text-xs uppercase tracking-[0.14em] text-[var(--color-accent)]">
                  Frontend release available
                </p>
                <h3 className="mt-2 font-serif text-2xl text-[var(--color-fg)]">
                  Vertebrae {update.version}
                </h3>
              </div>
              <Button
                variant="primary"
                onClick={onReview}
                data-testid="settings-review-update"
              >
                Review update
              </Button>
            </div>

            <dl className="mt-6 grid gap-4 border-y border-[var(--color-line)] py-4 sm:grid-cols-4">
              <div>
                <dt className="text-xs text-[var(--color-fg-mute)]">Channel</dt>
                <dd className="mt-1 text-sm text-[var(--color-fg)]">
                  {update.channel ?? GUI_UPDATE_CHANNEL}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-fg-mute)]">Version</dt>
                <dd className="mt-1 font-mono text-sm text-[var(--color-fg)]">
                  {update.version}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-fg-mute)]">Build</dt>
                <dd className="mt-1 font-mono text-sm text-[var(--color-fg)]">
                  {update.build ?? NOT_PROVIDED}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-fg-mute)]">
                  Published
                </dt>
                <dd className="mt-1 text-sm text-[var(--color-fg)]">
                  {publicationDate(update) ?? NOT_PROVIDED}
                </dd>
              </div>
            </dl>

            <section
              className="border-t border-[var(--color-line)] pt-5"
              aria-labelledby="settings-release-notes-heading"
              data-testid="settings-release-notes"
            >
              <h3
                id="settings-release-notes-heading"
                className="font-mono text-xs uppercase tracking-[0.14em] text-[var(--color-fg-mute)]"
              >
                Release notes
              </h3>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-[var(--color-fg-soft)]">
                {notes ?? "No release notes were provided for this release."}
              </p>
            </section>

            <UpdateComponents update={update} />
          </article>
        </div>
      ) : state.checking || state.status === "checking" ? (
        <UpdateStateMessage intent="status" testId="settings-updates-loading">
          Checking for signed updates…
        </UpdateStateMessage>
      ) : state.status === "error" ? (
        <UpdateStateMessage intent="alert" testId="settings-updates-failed">
          The update check failed.
        </UpdateStateMessage>
      ) : state.status === "unavailable" || state.status === "idle" ? (
        <UpdateStateMessage
          intent="status"
          testId="settings-updates-unavailable"
        >
          Signed update information is not available yet.
        </UpdateStateMessage>
      ) : (
        <UpdateStateMessage intent="status" testId="settings-updates-current">
          Frontend is up to date. No verified release is available.
        </UpdateStateMessage>
      )}
    </section>
  );
}

function BackendUpdatesSection({
  state,
  onReview,
}: {
  state: GuiUpdateState;
  onReview: () => void;
}) {
  const backend = state.localBackend;
  const management =
    backend.management === "not_configured" && backend.configured
      ? "managed_local"
      : backend.management;
  const backendApply = backend.apply;

  return (
    <section
      className="border-t border-[var(--color-line)] pt-8"
      data-testid="settings-backend-updates"
      aria-labelledby="settings-backend-updates-heading"
    >
      <h2
        id="settings-backend-updates-heading"
        className="font-serif text-2xl text-[var(--color-fg)]"
      >
        Backend
      </h2>
      {management === "external" ? (
        <>
          <BackendCurrentDetails state={state} />
          <UpdateStateMessage
            intent="status"
            testId="settings-backend-external"
          >
            This backend is managed externally, so the app cannot update it
            automatically.
          </UpdateStateMessage>
        </>
      ) : management === "managed_local" ? (
        <>
          <BackendCurrentDetails state={state} />
          {backendApply.status !== "idle" && (
            <LocalBackendUpdateApplyStatus apply={backendApply} />
          )}
          {backend.error && (
            <UpdateStateMessage
              intent="alert"
              testId="settings-local-backend-updates-failed"
            >
              The local backend update check failed: {backend.error}
            </UpdateStateMessage>
          )}
          {backend.update ? (
            <LocalBackendUpdateSection
              update={backend.update}
              onReview={onReview}
            />
          ) : backendApply.status === "idle" && !backend.error ? (
            <UpdateStateMessage
              intent="status"
              testId="settings-backend-current-status"
            >
              The local backend is up to date.
            </UpdateStateMessage>
          ) : null}
        </>
      ) : (
        <UpdateStateMessage
          intent="status"
          testId="settings-backend-not-configured"
        >
          No backend is configured.
        </UpdateStateMessage>
      )}
    </section>
  );
}

function UpdatesSection({
  state,
  onReview,
  onReviewBackend,
}: {
  state: GuiUpdateState;
  onReview: () => void;
  onReviewBackend: () => void;
}) {
  return (
    <div className="mt-8 space-y-8" data-testid="settings-updates">
      <FrontendUpdatesSection state={state} onReview={onReview} />
      <BackendUpdatesSection state={state} onReview={onReviewBackend} />
    </div>
  );
}

type SettingsSection = "chat" | "appearance" | "updates";

export interface SettingsPageProps {
  /** Optional test/integration hook; the default action applies the approved release. */
  onApproveUpdate?: (update: GuiUpdateInfo) => void;
  onApproveLocalBackendUpdate?: (update: LocalBackendUpdateInfo) => void;
}

export function SettingsPage({
  onApproveUpdate,
  onApproveLocalBackendUpdate,
}: SettingsPageProps = {}) {
  const [catalog, setCatalog] = useState<LocalChatHarnessCatalog | null>(null);
  const [externalEditors, setExternalEditors] = useState<LocalFileEditor[]>([]);
  const [externalEditorsLoading, setExternalEditorsLoading] = useState(false);
  const [externalEditorsError, setExternalEditorsError] = useState<
    string | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [savedFeedback, setSavedFeedback] = useState(false);
  const [activeSection, setActiveSection] = useState<SettingsSection>("chat");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [localBackendReviewOpen, setLocalBackendReviewOpen] = useState(false);
  const updateState = useGuiUpdateStore();
  const storageWarning = useLocalChatDefaultsStore(
    (state) => state.storageWarning
  );
  const defaultHarness = useLocalChatDefaultsStore(
    (state) => state.defaultHarness
  );
  const setDefaultHarness = useLocalChatDefaultsStore(
    (state) => state.setDefaultHarness
  );
  const theme = useUIStore((state) => state.theme);
  const setTheme = useUIStore((state) => state.setTheme);
  const externalEditor = useUIStore((state) => state.externalEditor);
  const setExternalEditor = useUIStore((state) => state.setExternalEditor);
  const harnesses = useMemo(() => catalog?.harnesses ?? [], [catalog]);
  const availableHarnesses = useMemo(
    () => harnesses.filter((info) => info.available),
    [harnesses]
  );
  const effectiveDefaultHarness = catalog
    ? resolveDefaultHarness(catalog, defaultHarness)
    : null;
  const externalEditorOptions = useMemo(() => {
    const configuredEditorIsMissing =
      externalEditor.length > 0 &&
      !externalEditors.some((editor) => editor.id === externalEditor);
    return [
      { value: "", label: "System default" },
      ...(configuredEditorIsMissing
        ? [
            {
              value: externalEditor,
              label: externalEditorsLoading
                ? "Configured editor"
                : "Configured editor (unavailable)",
            },
          ]
        : []),
      ...externalEditors.map((editor) => ({
        value: editor.id,
        label: editor.name,
      })),
    ];
  }, [externalEditor, externalEditors, externalEditorsLoading]);
  const updateIsAvailable =
    hasAvailableUpdate(updateState) || updateState.localBackend.update !== null;
  const approveUpdate =
    onApproveUpdate ??
    ((update: GuiUpdateInfo) => void applyApprovedGuiUpdate(update));
  const approveLocalBackendUpdate =
    onApproveLocalBackendUpdate ??
    ((update: LocalBackendUpdateInfo) =>
      void applyApprovedLocalBackendUpdate(update));

  useEffect(() => {
    if (!savedFeedback) return;
    const timeout = window.setTimeout(() => setSavedFeedback(false), 1200);
    return () => window.clearTimeout(timeout);
  }, [savedFeedback]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    void commands
      .getSupportedLocalChatHarnesses()
      .then((result) => {
        if (cancelled) return;
        if (result.status === "ok") {
          setCatalog(result.data);
          setError(null);
        } else {
          setError(result.error.message);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not load harness capabilities."
          );
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (activeSection !== "chat") return;

    let cancelled = false;
    setExternalEditorsLoading(true);
    setExternalEditorsError(null);
    void commands
      .getLocalFileEditors()
      .then((result) => {
        if (cancelled) return;
        if (result.status === "ok") {
          setExternalEditors(result.data);
          setExternalEditorsError(null);
        } else {
          setExternalEditors([]);
          setExternalEditorsError(result.error.message);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setExternalEditors([]);
          setExternalEditorsError("Could not load installed applications.");
        }
      })
      .finally(() => {
        if (!cancelled) setExternalEditorsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeSection]);

  const fileLinkSettings = (
    <div className="mt-8 border-t border-[var(--color-line)]">
      <p className="pt-5 font-mono text-xs uppercase tracking-[0.14em] text-[var(--color-fg-mute)]">
        File links
      </p>
      <SettingRow
        label="Open files with"
        description="Choose an installed app or editor command. This applies to every chat file link and ticket code reference."
      >
        <div>
          <Select
            aria-label="Open files with"
            data-testid="settings-external-editor"
            value={externalEditor}
            onChange={(event) => {
              setExternalEditor(event.target.value);
              setSavedFeedback(true);
            }}
            disabled={externalEditorsLoading}
            options={externalEditorOptions}
          />
          {externalEditorsError && (
            <p
              className="mt-2 text-xs text-[var(--color-warn)]"
              role="status"
              data-testid="settings-external-editor-error"
            >
              {externalEditorsError}
            </p>
          )}
        </div>
      </SettingRow>
    </div>
  );

  return (
    <main
      className="flex h-full min-h-0 flex-col overflow-hidden lg:flex-row"
      data-testid="settings-page"
    >
      <aside
        className="shrink-0 border-b border-[var(--color-line)] px-4 py-5 lg:w-52 lg:border-b-0 lg:border-r lg:px-5 lg:py-8"
        aria-label="Settings sections"
      >
        <p className="mb-3 px-3 font-mono text-[length:var(--text-9)] uppercase tracking-[0.16em] text-[var(--color-fg-mute)]">
          Settings
        </p>
        <nav>
          <button
            type="button"
            onClick={() => setActiveSection("chat")}
            className={`w-full rounded-[var(--radius-sm)] border-l-2 px-3 py-2 text-left font-serif text-lg ${
              activeSection === "chat"
                ? "border-[var(--color-accent)] bg-[var(--color-bg-1)] text-[var(--color-fg)]"
                : "border-transparent text-[var(--color-fg-soft)] hover:bg-[var(--color-bg-1)] hover:text-[var(--color-fg)]"
            }`}
            aria-current={activeSection === "chat" ? "page" : undefined}
            data-testid="settings-nav-chat"
          >
            Chat
          </button>
          <button
            type="button"
            onClick={() => setActiveSection("appearance")}
            className={`mt-1 w-full rounded-[var(--radius-sm)] border-l-2 px-3 py-2 text-left font-serif text-lg ${
              activeSection === "appearance"
                ? "border-[var(--color-accent)] bg-[var(--color-bg-1)] text-[var(--color-fg)]"
                : "border-transparent text-[var(--color-fg-soft)] hover:bg-[var(--color-bg-1)] hover:text-[var(--color-fg)]"
            }`}
            aria-current={activeSection === "appearance" ? "page" : undefined}
            data-testid="settings-nav-appearance"
          >
            Appearance
          </button>
          <button
            type="button"
            onClick={() => setActiveSection("updates")}
            className={`mt-1 flex w-full items-center justify-between gap-2 rounded-[var(--radius-sm)] border-l-2 px-3 py-2 text-left font-serif text-lg ${
              activeSection === "updates"
                ? "border-[var(--color-accent)] bg-[var(--color-bg-1)] text-[var(--color-fg)]"
                : "border-transparent text-[var(--color-fg-soft)] hover:bg-[var(--color-bg-1)] hover:text-[var(--color-fg)]"
            }`}
            aria-current={activeSection === "updates" ? "page" : undefined}
            data-testid="settings-nav-updates"
          >
            <span>Updates</span>
            {updateIsAvailable && (
              <span aria-label="1 update available">
                <Badge
                  count={1}
                  intent="accent"
                  testId="settings-nav-updates-badge"
                />
              </span>
            )}
          </button>
        </nav>
      </aside>

      <section className="min-w-0 flex-1 overflow-y-auto px-6 py-8 lg:px-12 lg:py-10">
        <div className="mx-auto max-w-4xl">
          <header className="flex items-start justify-between gap-4 border-b border-[var(--color-line)] pb-7">
            <div className="max-w-2xl">
              <h1 className="font-serif text-4xl text-[var(--color-fg)]">
                {activeSection === "appearance"
                  ? "Appearance"
                  : activeSection === "updates"
                    ? "Updates"
                    : "Chat"}
              </h1>
              <p className="mt-3 text-base leading-7 text-[var(--color-fg-soft)]">
                {activeSection === "appearance"
                  ? "Choose how Vertebrae should look across the application."
                  : activeSection === "updates"
                    ? "Review signed release metadata before deciding whether to approve an update."
                    : "Chat sessions are agent runs. These settings apply to new sessions; open and resumed sessions keep the configuration they started with."}
              </p>
            </div>
            <SaveIndicator visible={savedFeedback} />
          </header>

          {storageWarning && (
            <p
              className="mt-4 rounded-[var(--radius-md)] border border-[var(--color-warn)]/30 bg-[var(--color-warn-wash)] px-3 py-2 text-xs text-[var(--color-warn)]"
              role="status"
              data-testid="settings-storage-warning"
            >
              {storageWarning}
            </p>
          )}

          {activeSection === "appearance" ? (
            <div className="mt-8 border-t border-[var(--color-line)]">
              <SettingRow
                label="Theme"
                description="Choose whether Vertebrae follows the system, light, or dark appearance."
              >
                <Select
                  aria-label="Theme"
                  data-testid="settings-theme"
                  value={theme}
                  onChange={(event) => {
                    setTheme(event.target.value as "light" | "dark" | "system");
                    setSavedFeedback(true);
                  }}
                  options={[
                    { value: "system", label: "System" },
                    { value: "light", label: "Light" },
                    { value: "dark", label: "Dark" },
                  ]}
                />
              </SettingRow>
            </div>
          ) : activeSection === "updates" ? (
            <>
              <UpdateChannelSelector state={updateState} />
              <UpdatesSection
                state={updateState}
                onReview={() => {
                  if (
                    updateState.available &&
                    hasAvailableUpdate(updateState)
                  ) {
                    setReviewOpen(true);
                  }
                }}
                onReviewBackend={() => {
                  if (updateState.localBackend.update) {
                    setLocalBackendReviewOpen(true);
                  }
                }}
              />
            </>
          ) : (
            <>
              {fileLinkSettings}
              {isLoading ? (
                <div
                  className="mt-8 text-sm text-[var(--color-fg-mute)]"
                  role="status"
                >
                  Loading harness capabilities…
                </div>
              ) : error ? (
                <div
                  className="mt-8 rounded-[var(--radius-md)] border border-[var(--color-err)]/30 bg-[var(--color-err-wash)] p-4 text-sm text-[var(--color-err)]"
                  role="alert"
                  data-testid="settings-error"
                >
                  {error}
                </div>
              ) : harnesses.length === 0 ? (
                <div className="mt-8 rounded-[var(--radius-md)] border border-dashed border-[var(--color-line-strong)] p-6 text-sm text-[var(--color-fg-mute)]">
                  No local chat harnesses are available.
                </div>
              ) : (
                <div className="mt-8">
                  <div className="border-t border-[var(--color-line)]">
                    <p className="pt-5 font-mono text-xs uppercase tracking-[0.14em] text-[var(--color-fg-mute)]">
                      New sessions
                    </p>
                    <SettingRow
                      label="Default harness"
                      description="The harness used for every new chat session."
                    >
                      <Select
                        aria-label="Default harness"
                        data-testid="default-harness"
                        value={effectiveDefaultHarness ?? ""}
                        onChange={(event) => {
                          setDefaultHarness(
                            (event.target.value ||
                              null) as LocalChatHarnessKind | null
                          );
                          setSavedFeedback(true);
                        }}
                        disabled={availableHarnesses.length === 0}
                        options={availableHarnesses.map((info) => ({
                          value: info.harness,
                          label: `${info.label}${
                            info.harness === catalog?.default_harness
                              ? " (provider default)"
                              : ""
                          }`,
                        }))}
                      />
                    </SettingRow>
                  </div>

                  <div className="mt-5">
                    <p className="mb-2 font-mono text-xs uppercase tracking-[0.14em] text-[var(--color-fg-mute)]">
                      Harness defaults
                    </p>
                    <div className="space-y-7">
                      {harnesses.map((info) => (
                        <HarnessDefaultsSection
                          info={info}
                          key={info.harness}
                          onSaved={() => setSavedFeedback(true)}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </section>
      {reviewOpen &&
        updateState.available &&
        hasAvailableUpdate(updateState) && (
          <ReviewUpdateDialog
            update={updateState.available}
            stale={
              updateState.status === "error" || updateState.status === "stale"
            }
            onApprove={approveUpdate}
            onClose={() => setReviewOpen(false)}
          />
        )}
      {localBackendReviewOpen && updateState.localBackend.update && (
        <ReviewLocalBackendUpdateDialog
          update={updateState.localBackend.update}
          onApprove={approveLocalBackendUpdate}
          onClose={() => setLocalBackendReviewOpen(false)}
        />
      )}
    </main>
  );
}
