import { useEffect, useState } from "react";
import {
  commands,
  type LocalChatHarnessCatalog,
  type SettingsEdit,
  type SharedSettings,
} from "../../bindings";
import { Choice, Notice, TextField } from "./SettingsFields";
import { card } from "./settingsStyles";

type DecisionDraft = Extract<SettingsEdit, { section: "decision_model" }>;

export function DecisionModelForm({
  draft,
  settings,
  change,
}: {
  draft: DecisionDraft;
  settings: SharedSettings;
  change: (draft: SettingsEdit) => void;
}) {
  const [catalog, setCatalog] = useState<LocalChatHarnessCatalog | null>(null);
  useEffect(() => {
    let active = true;
    void commands
      .getSupportedLocalChatHarnesses()
      .then((result) => {
        if (active && result.status === "ok") setCatalog(result.data);
      })
      .catch(() => {
        /* Configured profiles remain usable without discovery. */
      });
    return () => {
      active = false;
    };
  }, []);
  const providers: [string, string][] = [
    ["anthropic", "Anthropic · Claude"],
    ["openai", "OpenAI · Codex"],
    ["typesafe", "TypeSafe"],
    ["mistral", "Mistral Vibe"],
    ...settings.providers.map((p): [string, string] => [
      p.id,
      `${p.id} · ${p.harness}`,
    ]),
  ];
  if (draft.provider && !providers.some(([id]) => id === draft.provider)) {
    providers.push([
      draft.provider,
      `${draft.provider} (no longer configured)`,
    ]);
  }
  const profile = settings.providers.find((p) => p.id === draft.provider);
  const provider = catalog?.providers.find((p) => p.id === draft.provider);
  const harness = catalog?.harnesses.find(
    (h) => h.harness === provider?.harness
  );
  const models: [string, string][] = profile
    ? profile.models.map((m) => [m, m])
    : (provider?.models ?? harness?.models ?? [])
        .filter((m) => m.id !== "default")
        .map((m) => [m.id, m.label]);
  if (
    draft.model &&
    models.length &&
    !models.some(([id]) => id === draft.model)
  ) {
    models.push([draft.model, `${draft.model} (saved selection)`]);
  }
  return (
    <div className={`${card} space-y-5`}>
      <Choice
        label="Decision model status"
        value={draft.enabled ? "enabled" : "disabled"}
        values={[
          ["disabled", "Disabled"],
          ["enabled", "Enabled"],
        ]}
        change={(value) => change({ ...draft, enabled: value === "enabled" })}
      />
      <Choice
        label="Decision provider"
        value={draft.provider}
        values={[["", "Select a provider"], ...providers]}
        change={(provider) => change({ ...draft, provider, model: "" })}
      />
      {models.length || profile ? (
        <Choice
          label="Decision model"
          value={draft.model}
          values={[["", "Select a model"], ...models]}
          change={(model) => change({ ...draft, model })}
        />
      ) : (
        <TextField
          label="Decision model"
          value={draft.model}
          change={(model) => change({ ...draft, model })}
          hint="Enter an exact model ID when this provider has no discovered model list."
        />
      )}
      <Notice>
        The selected provider supplies its harness and credentials. Chat
        defaults are independent. This setting prepares future background
        decisions; file-change capture and automatic session attribution are not
        enabled by it.
      </Notice>
      {provider && !provider.available && (
        <Notice>
          {provider.unavailable_reason ??
            "This provider is currently unavailable."}
        </Notice>
      )}
      {settings.decision_model.validation_error && (
        <Notice>{settings.decision_model.validation_error}</Notice>
      )}
      <Notice>
        Saved selections are read for new decision requests. Existing requests
        keep their configuration. Disabled by default.
      </Notice>
    </div>
  );
}
