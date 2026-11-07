import { useState } from "react";
import type { LocalChatHarnessCatalog } from "../../bindings";
import { useUIStore } from "../../stores/uiStore";
import { providerHarnessInfo } from "../../utils/localChatDefaults";
import {
  resolveDiscussionModel,
  readInlineDiscussionPreference,
  discussionOptionFields,
  type InlineDiscussionPreference,
} from "../../utils/inlineDiscussionModel";
import { Select, type SelectOption } from "../atoms/Select";

export function InlineDiscussionSettings({
  catalog,
  onSaved,
}: {
  catalog: LocalChatHarnessCatalog | null;
  onSaved(): void;
}) {
  const preference = useUIStore((state) => state.inlineDiscussionPreference);
  const setPreference = useUIStore(
    (state) => state.setInlineDiscussionPreference
  );
  const [storageError, setStorageError] = useState<string | null>(null);

  const save = (next: InlineDiscussionPreference) => {
    const storageOptions = useUIStore.persist?.getOptions();

    if (!storageOptions?.storage) {
      setStorageError(
        "Local settings storage is unavailable. Restore access to local storage before choosing an inline discussion model."
      );
      return;
    }

    try {
      const preference = readInlineDiscussionPreference(next);

      setPreference(preference);
      setStorageError(null);
      onSaved();
    } catch {
      setStorageError(
        "Could not save the inline discussion choice. It applies only to this app session. Restore local storage and select it again before restarting."
      );
    }
  };

  const providers =
    catalog?.providers.filter((provider) => {
      const info = providerHarnessInfo(catalog, provider);
      const modelCount = info?.models.length ?? 0;

      return provider.available && modelCount > 0;
    }) ?? [];

  const selected = preference.mode === "dedicated" ? preference : null;
  const provider = catalog?.providers.find(
    (item) => item.id === selected?.providerId
  );
  const info =
    catalog && provider ? providerHarnessInfo(catalog, provider) : null;
  const models = info?.models ?? [];
  const optionFields = selected
    ? discussionOptionFields(info, selected.modelId)
    : [];

  let error: string | null = null;

  if (preference.mode === "invalid") {
    error =
      "The saved choice is invalid. Choose a provider/model or follow the main conversation.";
  } else if (catalog && selected) {
    const mainSelection = {
      harness: provider?.harness ?? catalog.default_harness,
    };
    const choice = resolveDiscussionModel(selected, catalog, mainSelection);

    error = choice.error;
  }

  const modeOptions: SelectOption[] = [
    { value: "follow", label: "Follow main conversation" },
    {
      value: "dedicated",
      label: "Custom model",
      disabled: !providers.length,
    },
  ];

  if (preference.mode === "invalid") {
    modeOptions.push({
      value: "invalid",
      label: "Invalid saved choice",
      disabled: true,
    });
  }

  const providerOptions: SelectOption[] = providers.map((item) => ({
    value: item.id,
    label: item.label,
  }));
  const selectedProviderAvailable = providers.some(
    (item) => item.id === selected?.providerId
  );

  if (selected && !selectedProviderAvailable) {
    providerOptions.unshift({
      value: selected.providerId,
      label: `${selected.providerId} (unavailable)`,
      disabled: true,
    });
  }

  const modelOptions: SelectOption[] = models.map((item) => ({
    value: item.id,
    label: item.label,
  }));
  const selectedModelAvailable = models.some(
    (item) => item.id === selected?.modelId
  );

  if (selected && !selectedModelAvailable) {
    modelOptions.unshift({
      value: selected.modelId,
      label: `${selected.modelId} (unavailable)`,
      disabled: true,
    });
  }

  const chooseProvider = (id: string) => {
    const provider = providers.find((item) => item.id === id);
    const info = catalog && provider && providerHarnessInfo(catalog, provider);

    if (!info?.models.length) return;

    const defaultModel = info.models.find(
      (model) => model.id === info.default_model_id
    );
    const modelId = defaultModel?.id ?? info.models[0].id;
    const nextPreference: InlineDiscussionPreference = {
      mode: "dedicated",
      providerId: id,
      modelId,
    };

    save(nextPreference);
  };

  return (
    <section
      className="mt-8 border-t border-[var(--color-line)] pt-5"
      aria-label="Inline discussions"
    >
      <h3 className="text-sm font-medium">Inline discussions</h3>
      <p className="mt-1 text-sm text-[var(--color-fg-soft)]">
        Choose who answers questions about selected code. Changes apply to the
        next question, including follow-ups; running replies keep their captured
        model and context.
      </p>
      <div className="space-y-4 py-4">
        <label className="flex max-w-sm flex-col gap-1 text-sm">
          Answer using
          <Select
            aria-label="Inline discussion mode"
            value={preference.mode}
            onChange={(event) => {
              if (event.target.value === "follow") {
                save({ mode: "follow" });
              } else if (providers[0]) chooseProvider(providers[0].id);
            }}
            options={modeOptions}
          />
        </label>
        {selected && (
          <div
            className="grid items-end gap-3 sm:grid-cols-4"
            role="group"
            aria-label="Custom inline discussion options"
          >
            <label className="flex min-w-0 flex-col gap-1 text-sm">
              Provider
              <Select
                aria-label="Inline discussion provider"
                value={selected.providerId}
                onChange={(event) => chooseProvider(event.target.value)}
                options={providerOptions}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-sm">
              Model
              <Select
                aria-label="Inline discussion model"
                value={selected.modelId}
                disabled={!provider?.available}
                onChange={(event) => {
                  const nextPreference = {
                    ...selected,
                    modelId: event.target.value,
                  };
                  const fields = info
                    ? discussionOptionFields(info, nextPreference.modelId)
                    : [];

                  for (const field of fields) {
                    const value = nextPreference[field.key];
                    const supported = field.choices.some(
                      (choice) => choice.id === value
                    );

                    if (value && !supported) delete nextPreference[field.key];
                  }

                  save(nextPreference);
                }}
                options={modelOptions}
              />
            </label>
            {optionFields.map((field) => {
              const value = selected[field.key] ?? "";
              const supported = field.choices.some(
                (choice) => choice.id === value
              );
              const available = field.choices.length > 0;
              const choices = field.choices.map((choice) => ({
                value: choice.id,
                label: choice.label,
              }));
              const options: SelectOption[] = [
                {
                  value: "",
                  label: available ? "Provider default" : "Not available",
                },
                ...choices,
              ];

              if (value && !supported) {
                options.push({
                  value,
                  label: `${value} (unavailable)`,
                  disabled: true,
                });
              }

              const accessibleLabel = `Inline discussion ${field.label.toLowerCase()}`;

              return (
                <label
                  key={field.key}
                  className="flex min-w-0 flex-col gap-1 text-sm"
                >
                  {field.label}
                  <Select
                    aria-label={accessibleLabel}
                    value={value}
                    options={options}
                    disabled={!provider?.available || !available}
                    onChange={(event) => {
                      const option = event.target.value || undefined;
                      const nextPreference = {
                        ...selected,
                        [field.key]: option,
                      };

                      save(nextPreference);
                    }}
                  />
                </label>
              );
            })}
          </div>
        )}
      </div>
      <p className="text-sm text-[var(--color-fg-soft)]">
        Inline discussions always use the enforced read-only permission policy.
        Model changes reset options the new model does not support.
      </p>
      {storageError && (
        <p role="alert" className="text-sm">
          {storageError}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
    </section>
  );
}
