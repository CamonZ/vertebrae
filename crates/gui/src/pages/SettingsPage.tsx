import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  commands,
  type LocalChatHarnessCatalog,
  type LocalChatHarnessInfo,
  type LocalChatHarnessKind,
  type PermissionMode,
} from "../bindings";
import { Icon } from "../components/atoms/Icon";
import { Select } from "../components/atoms/Select";
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

type SettingsSection = "chat" | "appearance";

export function SettingsPage() {
  const [catalog, setCatalog] = useState<LocalChatHarnessCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [savedFeedback, setSavedFeedback] = useState(false);
  const [activeSection, setActiveSection] = useState<SettingsSection>("chat");
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
  const harnesses = useMemo(() => catalog?.harnesses ?? [], [catalog]);
  const availableHarnesses = useMemo(
    () => harnesses.filter((info) => info.available),
    [harnesses]
  );
  const effectiveDefaultHarness = catalog
    ? resolveDefaultHarness(catalog, defaultHarness)
    : null;

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
        </nav>
      </aside>

      <section className="min-w-0 flex-1 overflow-y-auto px-6 py-8 lg:px-12 lg:py-10">
        <div className="mx-auto max-w-4xl">
          <header className="flex items-start justify-between gap-4 border-b border-[var(--color-line)] pb-7">
            <div className="max-w-2xl">
              <h1 className="font-serif text-4xl text-[var(--color-fg)]">
                {activeSection === "appearance" ? "Appearance" : "Chat"}
              </h1>
              <p className="mt-3 text-base leading-7 text-[var(--color-fg-soft)]">
                {activeSection === "appearance"
                  ? "Choose how Vertebrae should look across the application."
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
          ) : isLoading ? (
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
        </div>
      </section>
    </main>
  );
}
