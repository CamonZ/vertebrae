import type {
  LocalChatHarnessCatalog,
  LocalChatHarnessInfo,
  LocalChatHarnessKind,
} from "../bindings";
import {
  sessionProviderId,
  providerHarnessInfo,
  reasoningEffortsForModel,
  speedTiersForModel,
  personalityOptionsForModel,
} from "./localChatDefaults";

export interface DiscussionRequestOptions {
  reasoningEffort?: string | null;
  speedTier?: string | null;
  personality?: string | null;
}

export interface MainDiscussionSelection extends DiscussionRequestOptions {
  harness: LocalChatHarnessKind;
  providerId?: string;
  modelId?: string | null;
}

/** Application-wide preference. Only IDs are persisted, never catalog or credentials. */
export type InlineDiscussionPreference =
  | { mode: "follow" }
  | ({
      mode: "dedicated";
      providerId: string;
      modelId: string;
    } & Omit<DiscussionRequestOptions, "personality">)
  | { mode: "invalid" };

export function readInlineDiscussionPreference(
  value: unknown
): InlineDiscussionPreference {
  if (value === undefined) return { mode: "follow" }; // Existing installations.

  if (value && typeof value === "object" && "mode" in value) {
    if (value.mode === "follow") return { mode: "follow" };

    if (
      value.mode === "dedicated" &&
      "providerId" in value &&
      typeof value.providerId === "string" &&
      value.providerId.trim() &&
      "modelId" in value &&
      typeof value.modelId === "string" &&
      value.modelId.trim()
    ) {
      const options: DiscussionRequestOptions = {};
      const saved = value as Record<string, unknown>;

      for (const key of ["reasoningEffort", "speedTier"] as const) {
        const option = saved[key];

        if (option === undefined || option === null) continue;
        if (typeof option !== "string" || !option.trim())
          return { mode: "invalid" };

        options[key] = option;
      }

      return {
        mode: "dedicated",
        providerId: value.providerId,
        modelId: value.modelId,
        ...options,
      };
    }
  }

  return { mode: "invalid" }; // Consequential settings must not silently switch providers.
}

export function discussionOptionFields(
  info: LocalChatHarnessInfo | null,
  modelId: string
) {
  const efforts = info ? reasoningEffortsForModel(info, modelId) : [];
  const tiers = info ? speedTiersForModel(info, modelId) : [];

  return [
    {
      key: "reasoningEffort" as const,
      label: "Reasoning effort",
      choices: efforts,
    },
    { key: "speedTier" as const, label: "Speed tier", choices: tiers },
  ];
}

export type DiscussionModelChoice =
  | {
      label: string;
      error: null;
      harness: LocalChatHarnessKind;
      providerId: string;
      modelId: string;
      reasoningEffort: string | null;
      speedTier: string | null;
      personality: string | null;
    }
  | { label: string; error: string };

export function resolveDiscussionModel(
  preference: InlineDiscussionPreference,
  catalog: LocalChatHarnessCatalog,
  main: MainDiscussionSelection
): DiscussionModelChoice {
  const invalid = (reason: string): DiscussionModelChoice => ({
    label: "Inline discussion unavailable",
    error: `${reason} Open Settings → Diffs & code editor → Inline discussions to choose an available provider and model, or follow the main conversation.`,
  });

  if (preference.mode === "invalid")
    return invalid("The saved inline discussion choice is invalid.");

  const providerId =
    preference.mode === "dedicated"
      ? preference.providerId
      : sessionProviderId(main);
  const provider = catalog.providers.find((item) => item.id === providerId);

  if (!provider?.available)
    return invalid(`Provider ${providerId} is unavailable or removed.`);

  if (preference.mode === "follow" && provider.harness !== main.harness)
    return invalid(
      "The main conversation's provider configuration has changed."
    );

  const info = providerHarnessInfo(catalog, provider);
  if (!info) return invalid(`Provider ${providerId} has no model catalog.`);

  const selected =
    preference.mode === "dedicated" ? preference.modelId : main.modelId;
  const modelId = selected || info.default_model_id;
  const model = info.models.find((item) => item.id === modelId);

  if (!model)
    return invalid(
      `Model ${modelId || "default"} is unavailable for ${provider.label}. Select an explicit model in the main conversation or Settings.`
    );

  const options = preference.mode === "dedicated" ? preference : main;
  const fields = discussionOptionFields(info, model.id);
  const optionLabels: string[] = [];

  for (const field of fields) {
    const value = options[field.key];

    if (!value) continue;

    const matching = field.choices.find((item) => item.id === value);

    if (!matching) {
      const reason = `${field.label} ${value} is unavailable for ${model.label}.`;

      return invalid(reason);
    }

    optionLabels.push(`${field.label}: ${matching.label}`);
  }

  const personality =
    preference.mode === "follow" ? (main.personality ?? null) : null;

  if (personality) {
    const styles = personalityOptionsForModel(info, model.id);
    const style = styles.find((choice) => choice.id === personality);

    if (!style)
      return invalid(
        `The main conversation's style ${personality} is unavailable for ${model.label}.`
      );

    optionLabels.push(`Style: ${style.label}`);
  }

  const defaultSuffix = selected ? "" : " (provider default)";
  const modelLabel = `${provider.label} · ${model.label}${defaultSuffix}`;
  const labelParts = [modelLabel, ...optionLabels];
  const label = labelParts.join(" · ");

  return {
    harness: provider.harness,
    providerId,
    modelId: model.id,
    reasoningEffort: options.reasoningEffort ?? null,
    speedTier: options.speedTier ?? null,
    personality,
    error: null,
    label,
  };
}
