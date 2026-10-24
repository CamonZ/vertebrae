import { useProviderSettingsStore } from "../../stores/providerSettingsStore";
import { card } from "./settingsStyles";
import { useCallback, useEffect, useRef, useState } from "react";
import { useBlocker } from "react-router-dom";
import {
  commands,
  type SettingsEdit,
  type SharedSettings,
} from "../../bindings";
import { Button } from "../atoms/Button";
import { Modal } from "../molecules/Modal";

import { TextField, Choice, SecretField, Notice } from "./SettingsFields";
import {
  draftFor,
  providerDraft,
  validateSettingsDraft,
  type ConfigSection,
} from "./settingsDraft";
import { SettingsValidationContext } from "./settingsValidation";
import { DecisionModelForm } from "./DecisionModelForm";
import { ProviderForm } from "./ProviderForm";
export type { ConfigSection } from "./settingsDraft";

export function SharedConfigSettings({
  section,
  onDirty,
  onBusy,
}: {
  section: ConfigSection;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
}) {
  const request = useRef(0);
  const [settings, setSettings] = useState<SharedSettings | null>(null);
  const [draft, setDraft] = useState<SettingsEdit | null>(null);
  const [baseline, setBaseline] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState<SettingsEdit | "reload" | null>(null);
  const dirty = draft !== null && JSON.stringify(draft) !== baseline;
  const blocker = useBlocker(dirty || busy);
  const install = useCallback((data: SharedSettings, next: SettingsEdit) => {
    setSettings(data);
    setDraft(next);
    setBaseline(JSON.stringify(next));
    setError(null);
  }, []);
  const load = useCallback(async () => {
    const current = ++request.current;
    setBusy(true);
    setError(null);
    try {
      const result = await commands.getSharedSettings();
      if (current !== request.current) return;
      if (result.status === "error") setError(result.error.message);
      else install(result.data, draftFor(section, result.data));
    } catch {
      if (current !== request.current) return;
      setError(
        "Could not load settings. Check file permissions and try again."
      );
    } finally {
      if (current === request.current) setBusy(false);
    }
  }, [install, section]);
  useEffect(() => {
    void load();
    return () => {
      request.current += 1;
    };
  }, [load]);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty, busy]);
  const select = (next: SettingsEdit) => {
    if (dirty) {
      setPending(next);
      return;
    }
    setDraft(next);
    setBaseline(JSON.stringify(next));
    setSaved(false);
    setError(null);
  };
  const change = (next: SettingsEdit) => {
    setDraft(next);
    setSaved(false);
  };
  const hiddenEndpoint =
    draft?.section === "typesafe"
      ? settings?.typesafe_endpoint_hidden
      : draft?.section === "provider"
        ? settings?.providers.find((p) => p.id === draft.id)?.endpoint_hidden
        : false;
  const endpointMissing =
    draft?.section === "typesafe"
      ? !draft.url.trim()
      : draft?.section === "provider"
        ? !draft.endpoint.trim()
        : false;
  const validation = draft
    ? (validateSettingsDraft(draft) ??
      (hiddenEndpoint && endpointMissing
        ? {
            field:
              draft.section === "provider" && draft.harness !== "typesafe"
                ? "API base URL"
                : "System One endpoint",
            message:
              "The stored endpoint is hidden because it contains sensitive URL components. Enter a safe replacement endpoint before saving.",
          }
        : null))
    : null;
  async function save() {
    if (!settings || !draft || busy || validation) return;
    setBusy(true);
    setError(null);
    try {
      const result = await commands.saveSharedSettings(
        settings.revision,
        draft
      );
      if (result.status === "error") setError(result.error.message);
      else {
        const next =
          draft.section === "provider"
            ? providerDraft(
                result.data.providers.find((p) => p.id === draft.id)
              )
            : draftFor(section, result.data);
        install(result.data, next);
        setSaved(true);
        if (draft.section === "provider" || draft.section === "typesafe") {
          useProviderSettingsStore.getState().changed();
        }
      }
    } catch {
      setError("Could not save settings. Your edits have been retained.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-7 space-y-5" data-testid={`shared-settings-${section}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--color-fg-mute)]">
        <div>
          <span className="font-medium">This machine · config.toml</span>
          {settings && (
            <p className="mt-1 break-all font-mono">{settings.path}</p>
          )}
        </div>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            if (dirty) setPending("reload");
            else void load();
          }}
        >
          Reload
        </Button>
      </div>
      {settings?.credential_warning && (
        <p role="status" className="text-sm text-[var(--color-warn)]">
          {settings.credential_warning}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-[var(--color-err)]">
          {error}
        </p>
      )}
      {!draft && !error && <p role="status">Loading settings…</p>}
      {settings && draft && (
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <SettingsValidationContext.Provider value={dirty ? validation : null}>
            {hiddenEndpoint && (
              <Notice>
                The stored endpoint contains sensitive URL components and has
                been hidden. Enter a safe replacement endpoint to save changes.
              </Notice>
            )}
            <fieldset disabled={busy} className="space-y-5">
              {section === "providers" && (
                <>
                  <Notice>
                    Built-in providers: Anthropic (Claude), OpenAI (Codex),
                    TypeSafe, and Mistral Vibe. Custom profiles select an
                    existing harness; availability depends on its installed
                    runtime. Chat defaults remain in Chat settings.
                  </Notice>
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => select(draftFor(section, settings))}>
                      TypeSafe
                    </Button>
                    {settings.providers.map((p) => (
                      <Button
                        key={p.id}
                        aria-pressed={
                          draft.section === "provider" && draft.id === p.id
                        }
                        onClick={() => select(providerDraft(p))}
                      >
                        {p.id}
                      </Button>
                    ))}
                    <Button onClick={() => select(providerDraft())}>
                      Add provider
                    </Button>
                  </div>
                  <Notice>
                    Saved provider changes apply to new sessions and requests.
                    Existing sessions keep their configuration.
                  </Notice>
                </>
              )}
              {draft.section === "decision_model" && (
                <DecisionModelForm
                  draft={draft}
                  settings={settings}
                  change={change}
                />
              )}
              {draft.section === "connection" && (
                <div className={`${card} space-y-5`}>
                  <TextField
                    label="Backend URL"
                    value={draft.url}
                    change={(url) => change({ ...draft, url })}
                  />
                  <SecretField
                    label="Backend token"
                    configured={settings.has_connection_token}
                    value={draft.token}
                    change={(token) => change({ ...draft, token })}
                    allowClear={settings.connection_token_override}
                  />
                  {(settings.connection_url_override ||
                    settings.connection_token_override) && (
                    <Notice>
                      {settings.connection_url_override && (
                        <>
                          VTB_URL overrides the saved URL in this GUI process.
                          Effective URL:{" "}
                          {settings.effective_connection_url ||
                            "hidden because it contains sensitive URL components"}
                          .{" "}
                        </>
                      )}
                      {settings.connection_token_override && (
                        <>
                          VTB_TOKEN overrides the saved token. Its value is
                          hidden.
                        </>
                      )}
                    </Notice>
                  )}
                  <Notice>
                    Saving updates this machine’s configuration. Restart the GUI
                    to reconnect using the new settings. Projects continue to
                    use the existing project management interface.
                  </Notice>
                </div>
              )}
              {draft.section === "typesafe" && (
                <div className={`${card} space-y-5`}>
                  <h2 className="font-serif text-2xl">TypeSafe</h2>
                  <TextField
                    label="System One endpoint"
                    hint="Leave blank to use the built-in endpoint."
                    value={draft.url}
                    change={(url) => change({ ...draft, url })}
                  />
                  <SecretField
                    label="TypeSafe API key"
                    storage={settings.typesafe_key_storage}
                    configured={settings.has_typesafe_key}
                    value={draft.key}
                    change={(key) => change({ ...draft, key })}
                  />
                  {(settings.typesafe_key_override ||
                    settings.typesafe_url_override) && (
                    <Notice>
                      {settings.typesafe_key_override &&
                        "TYPESAFE_API_KEY overrides the saved credential. "}
                      {settings.typesafe_url_override &&
                        "TYPESAFE_BASE_URL overrides the saved endpoint. "}
                      Overrides refer to this GUI process; the daemon may have a
                      different environment.
                    </Notice>
                  )}
                </div>
              )}
              {draft.section === "provider" && (
                <ProviderForm
                  draft={draft}
                  stored={settings.providers.find((p) => p.id === draft.id)}
                  change={change}
                />
              )}
              {draft.section === "observability" && (
                <div className={`${card} space-y-5`}>
                  <h2 className="font-serif text-2xl">Telemetry collection</h2>
                  <label className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={draft.settings.enabled}
                      onChange={(e) =>
                        change({
                          ...draft,
                          settings: {
                            ...draft.settings,
                            enabled: e.target.checked,
                          },
                        })
                      }
                    />
                    Enable telemetry
                  </label>
                  <TextField
                    label="Collector endpoint"
                    value={draft.settings.endpoint}
                    change={(endpoint) =>
                      change({
                        ...draft,
                        settings: { ...draft.settings, endpoint },
                      })
                    }
                  />
                  <Choice
                    label="Protocol"
                    value={draft.settings.protocol}
                    values={[
                      ["http/protobuf", "HTTP / Protobuf"],
                      ["grpc", "gRPC"],
                    ]}
                    change={(protocol) =>
                      change({
                        ...draft,
                        settings: { ...draft.settings, protocol },
                      })
                    }
                  />
                  <Choice
                    label="Log level"
                    value={draft.settings.level}
                    values={["trace", "debug", "info", "warn", "error"].map(
                      (v) => [v, v]
                    )}
                    change={(level) =>
                      change({
                        ...draft,
                        settings: { ...draft.settings, level },
                      })
                    }
                  />
                  {(
                    [
                      ["signals", ["traces", "metrics", "logs"]],
                      ["subsystems", ["local_chat", "claude_code"]],
                    ] as const
                  ).map(([key, values]) => (
                    <fieldset key={key} className="space-y-2">
                      <legend className="mb-2 text-sm font-medium">
                        {key === "signals" ? "Signals" : "Subsystems"}
                      </legend>
                      {values.map((v) => (
                        <label
                          className="flex items-center gap-3 text-sm"
                          key={v}
                        >
                          <input
                            type="checkbox"
                            checked={draft.settings[key].includes(v)}
                            onChange={(e) =>
                              change({
                                ...draft,
                                settings: {
                                  ...draft.settings,
                                  [key]: e.target.checked
                                    ? [...draft.settings[key], v]
                                    : draft.settings[key].filter(
                                        (x) => x !== v
                                      ),
                                },
                              })
                            }
                          />
                          {v.replace(/_/g, " ")}
                        </label>
                      ))}
                    </fieldset>
                  ))}
                  <label className="flex items-center gap-3 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.settings.capture_message_content}
                      onChange={(e) =>
                        change({
                          ...draft,
                          settings: {
                            ...draft.settings,
                            capture_message_content: e.target.checked,
                          },
                        })
                      }
                    />
                    Include message content
                  </label>
                  <Notice>
                    Message-content capture sends chat text to your collector.
                    Keep it off to collect metadata only. Saved telemetry
                    settings take effect after restarting the GUI.
                  </Notice>
                </div>
              )}
            </fieldset>
          </SettingsValidationContext.Provider>
          {validation && dirty && (
            <p
              id="settings-validation"
              role="alert"
              className="text-sm text-[var(--color-err)]"
            >
              {validation.message}
            </p>
          )}
          <div className="sticky bottom-0 flex items-center gap-3 border-t border-[var(--color-line)] bg-[var(--color-bg)] py-4">
            <Button
              type="submit"
              variant="primary"
              disabled={!dirty || !!validation || busy}
              loading={busy}
            >
              Save changes
            </Button>
            <Button
              disabled={!dirty || busy}
              onClick={() => {
                setDraft(JSON.parse(baseline) as SettingsEdit);
                setError(null);
                setSaved(false);
              }}
            >
              Discard
            </Button>
            <span role="status" className="text-sm text-[var(--color-fg-mute)]">
              {saved
                ? draft.section === "provider" ||
                  draft.section === "typesafe" ||
                  draft.section === "decision_model"
                  ? "Settings saved. Applies to new sessions and requests."
                  : "Settings saved. Restart the GUI to apply these settings."
                : dirty
                  ? "Unsaved changes"
                  : ""}
            </span>
          </div>
        </form>
      )}
      <Modal
        open={pending !== null}
        onClose={() => setPending(null)}
        title="Unsaved settings"
      >
        <p className="mb-5 text-sm">Discard your unsaved settings changes?</p>
        <div className="flex gap-3">
          <Button onClick={() => setPending(null)}>Keep editing</Button>
          <Button
            variant="danger"
            onClick={() => {
              if (pending === "reload") void load();
              else if (pending) {
                setDraft(pending);
                setBaseline(JSON.stringify(pending));
                setError(null);
                setSaved(false);
              }
              setPending(null);
            }}
          >
            Discard changes
          </Button>
        </div>
      </Modal>
      <Modal
        open={blocker.state === "blocked"}
        onClose={() => blocker.state === "blocked" && blocker.reset()}
        title="Unsaved settings"
      >
        <p className="mb-5 text-sm">
          {busy
            ? "Wait for the current settings operation to finish."
            : "Leave Settings and discard your unsaved changes?"}
        </p>
        <div className="flex gap-3">
          <Button
            onClick={() => blocker.state === "blocked" && blocker.reset()}
          >
            Keep editing
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => blocker.state === "blocked" && blocker.proceed()}
          >
            Discard and leave
          </Button>
        </div>
      </Modal>
    </div>
  );
}
