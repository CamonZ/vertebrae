import { create } from "zustand";
import type {
  LocalChatHarnessCatalog,
  LocalChatHarnessInfo,
  LocalChatHarnessKind,
  LocalChatProviderInfo,
  PermissionMode,
} from "../bindings";

export const LOCAL_CHAT_DEFAULTS_STORAGE_KEY =
  "vertebrae.local-chat-provider-defaults.v2";
/** Pre-provider defaults keyed by harness; migrated on first read. */
export const LEGACY_LOCAL_CHAT_DEFAULTS_STORAGE_KEY =
  "vertebrae.local-chat-harness-defaults.v1";

export const BUILTIN_PROVIDER_BY_HARNESS: Record<LocalChatHarnessKind, string> =
  {
    claude: "anthropic",
    codex: "openai",
  };

export interface LocalChatHarnessDefaults {
  modelId?: string;
  reasoningEffort?: string;
  speedTier?: string;
  permissionMode?: PermissionMode;
  personality?: string;
}

export interface LocalChatProviderRef {
  id: string;
  harness: LocalChatHarnessKind;
}

export type LocalChatDefaults = Partial<
  Record<string, LocalChatHarnessDefaults>
>;

interface LocalChatDefaultsState {
  defaults: LocalChatDefaults;
  defaultProvider: LocalChatProviderRef | null;
  storageWarning: string | null;
  setDefaultProvider: (provider: LocalChatProviderRef | null) => void;
  setModelDefault: (providerId: string, modelId: string | null) => void;
  setReasoningEffortDefault: (
    providerId: string,
    reasoningEffort: string | null
  ) => void;
  setSpeedTierDefault: (providerId: string, speedTier: string | null) => void;
  setPermissionDefault: (
    providerId: string,
    permissionMode: PermissionMode | null
  ) => void;
  setPersonalityDefault: (
    providerId: string,
    personality: string | null
  ) => void;
  resetProvider: (providerId: string) => void;
}

const HARNESS_KINDS: LocalChatHarnessKind[] = ["claude", "codex"];
const PERMISSION_MODES: PermissionMode[] = [
  "accept_edits",
  "auto",
  "bypass_permissions",
  "default",
  "dont_ask",
  "plan",
];
const SPEED_TIERS = ["default", "fast"] as const;

function isHarnessKind(value: unknown): value is LocalChatHarnessKind {
  return (
    typeof value === "string" &&
    HARNESS_KINDS.includes(value as LocalChatHarnessKind)
  );
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === "string" &&
    PERMISSION_MODES.includes(value as PermissionMode)
  );
}

function isSpeedTier(value: unknown): value is (typeof SPEED_TIERS)[number] {
  return typeof value === "string" && SPEED_TIERS.includes(value as never);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function sessionProviderId(session: {
  harness: LocalChatHarnessKind;
  providerId?: string | null;
}): string {
  return session.providerId?.trim() || BUILTIN_PROVIDER_BY_HARNESS[session.harness];
}

function readProviderDefaults(value: unknown): LocalChatHarnessDefaults | null {
  if (!isRecord(value)) return null;
  const trimmed = (candidate: unknown) =>
    typeof candidate === "string" && candidate.trim()
      ? candidate.trim()
      : undefined;
  const defaults: LocalChatHarnessDefaults = {
    modelId: trimmed(value.modelId),
    reasoningEffort: trimmed(value.reasoningEffort),
    speedTier: isSpeedTier(value.speedTier) ? value.speedTier : undefined,
    permissionMode: isPermissionMode(value.permissionMode)
      ? value.permissionMode
      : undefined,
    personality: trimmed(value.personality),
  };
  return Object.values(defaults).some(Boolean) ? defaults : null;
}

function readProviderRef(value: unknown): LocalChatProviderRef | null {
  if (!isRecord(value)) return null;
  return typeof value.id === "string" &&
    value.id.trim() &&
    isHarnessKind(value.harness)
    ? { id: value.id.trim(), harness: value.harness }
    : null;
}

/** Map harness-keyed v1 defaults onto their built-in providers. */
function migrateLegacyDefaults(parsed: Record<string, unknown>): {
  defaults: LocalChatDefaults;
  defaultProvider: LocalChatProviderRef | null;
} {
  const storedHarnesses = isRecord(parsed.harnesses) ? parsed.harnesses : parsed;
  const defaults: LocalChatDefaults = {};
  for (const [harness, value] of Object.entries(storedHarnesses)) {
    if (!isHarnessKind(harness)) continue;
    const providerDefaults = readProviderDefaults(value);
    if (providerDefaults) {
      defaults[BUILTIN_PROVIDER_BY_HARNESS[harness]] = providerDefaults;
    }
  }
  const defaultProvider = isHarnessKind(parsed.defaultHarness)
    ? {
        id: BUILTIN_PROVIDER_BY_HARNESS[parsed.defaultHarness],
        harness: parsed.defaultHarness,
      }
    : null;
  return { defaults, defaultProvider };
}

function readStoredDefaults(): {
  defaults: LocalChatDefaults;
  defaultProvider: LocalChatProviderRef | null;
  storageWarning: string | null;
} {
  const empty = { defaults: {}, defaultProvider: null };
  if (typeof window === "undefined") {
    return { ...empty, storageWarning: null };
  }

  try {
    const raw = window.localStorage.getItem(LOCAL_CHAT_DEFAULTS_STORAGE_KEY);
    if (!raw) {
      const legacy = window.localStorage.getItem(
        LEGACY_LOCAL_CHAT_DEFAULTS_STORAGE_KEY
      );
      if (!legacy) return { ...empty, storageWarning: null };
      const parsedLegacy: unknown = JSON.parse(legacy);
      if (!isRecord(parsedLegacy)) {
        return {
          ...empty,
          storageWarning: "Saved defaults were invalid; using provider defaults.",
        };
      }
      return { ...migrateLegacyDefaults(parsedLegacy), storageWarning: null };
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return {
        ...empty,
        storageWarning: "Saved defaults were invalid; using provider defaults.",
      };
    }

    const defaults: LocalChatDefaults = {};
    const storedProviders = isRecord(parsed.providers) ? parsed.providers : {};
    for (const [providerId, value] of Object.entries(storedProviders)) {
      const providerDefaults = readProviderDefaults(value);
      if (providerId.trim() && providerDefaults) {
        defaults[providerId.trim()] = providerDefaults;
      }
    }
    return {
      defaults,
      defaultProvider: readProviderRef(parsed.defaultProvider),
      storageWarning: null,
    };
  } catch {
    return {
      ...empty,
      storageWarning:
        "Saved defaults could not be read; using provider defaults.",
    };
  }
}

function writeStoredDefaults(
  defaults: LocalChatDefaults,
  defaultProvider: LocalChatProviderRef | null
): string | null {
  if (typeof window === "undefined") return null;
  try {
    window.localStorage.setItem(
      LOCAL_CHAT_DEFAULTS_STORAGE_KEY,
      JSON.stringify({ defaultProvider, providers: defaults })
    );
    return null;
  } catch {
    // Settings are a convenience. A disabled or unavailable storage backend
    // must not prevent the chat UI from loading.
    return "Defaults could not be saved on this device; they will remain active until the app reloads.";
  }
}

function updateProviderDefaults(
  defaults: LocalChatDefaults,
  providerId: string,
  update: (current: LocalChatHarnessDefaults) => LocalChatHarnessDefaults
): LocalChatDefaults {
  const nextProvider = update(defaults[providerId] ?? {});
  const next = { ...defaults };
  if (Object.keys(nextProvider).length === 0) {
    delete next[providerId];
  } else {
    next[providerId] = nextProvider;
  }
  return next;
}

export const useLocalChatDefaultsStore = create<LocalChatDefaultsState>(
  (set) => {
    const initial = readStoredDefaults();
    const setField =
      (
        field: keyof LocalChatHarnessDefaults,
        normalize: (value: string | null) => string | undefined
      ) =>
      (providerId: string, value: string | null) =>
        set((state) => {
          const defaults = updateProviderDefaults(
            state.defaults,
            providerId,
            (current) => {
              const next = { ...current } as Record<string, string | undefined>;
              const normalized = normalize(value);
              if (normalized) next[field] = normalized;
              else delete next[field];
              return next as LocalChatHarnessDefaults;
            }
          );
          return {
            defaults,
            storageWarning: writeStoredDefaults(defaults, state.defaultProvider),
          };
        });
    const trimmed = (value: string | null) => value?.trim() || undefined;
    return {
      defaults: initial.defaults,
      defaultProvider: initial.defaultProvider,
      storageWarning: initial.storageWarning,
      setModelDefault: setField("modelId", trimmed),
      setReasoningEffortDefault: setField("reasoningEffort", trimmed),
      setSpeedTierDefault: setField("speedTier", (value) =>
        isSpeedTier(value) ? value : undefined
      ),
      setPermissionDefault: (providerId, permissionMode) =>
        setField("permissionMode", (value) =>
          isPermissionMode(value) ? value : undefined
        )(providerId, permissionMode),
      setPersonalityDefault: setField("personality", trimmed),
      resetProvider: (providerId) =>
        set((state) => {
          if (!state.defaults[providerId]) return state;
          const defaults = { ...state.defaults };
          delete defaults[providerId];
          return {
            defaults,
            storageWarning: writeStoredDefaults(defaults, state.defaultProvider),
          };
        }),
      setDefaultProvider: (defaultProvider) =>
        set((state) => ({
          defaultProvider,
          storageWarning: writeStoredDefaults(state.defaults, defaultProvider),
        })),
    };
  }
);

/**
 * The harness capabilities as seen through a provider: custom providers
 * replace the model list and default model with their configured ones and
 * carry their own availability.
 */
export function providerHarnessInfo(
  catalog: Pick<LocalChatHarnessCatalog, "harnesses">,
  provider: LocalChatProviderInfo
): LocalChatHarnessInfo | null {
  const info = catalog.harnesses.find(
    (candidate) => candidate.harness === provider.harness
  );
  if (!info) return null;
  return {
    ...info,
    // Built-in providers keep their harness label ("Claude", "Codex") for
    // the model controls; custom providers are labeled by their ID.
    label: provider.custom ? provider.label : info.label,
    available: provider.available,
    unavailable_reason: provider.unavailable_reason,
    models: provider.models ?? info.models,
    default_model_id: provider.models
      ? provider.default_model_id
      : info.default_model_id,
  };
}

export function resolveModelDefaultId(
  info: Pick<LocalChatHarnessInfo, "models" | "default_model_id">,
  override?: string
): string | null {
  if (override && info.models.some((model) => model.id === override)) {
    return override;
  }
  if (
    info.default_model_id &&
    info.models.some((model) => model.id === info.default_model_id)
  ) {
    return info.default_model_id;
  }
  return null;
}

export function resolvePermissionDefault(
  info: Pick<LocalChatHarnessInfo, "permission_modes">,
  override?: PermissionMode
): PermissionMode | null {
  const modes = info.permission_modes ?? [];
  if (override && modes.some((mode) => mode.id === override)) {
    return override;
  }
  return modes.find((mode) => mode.is_default)?.id ?? modes[0]?.id ?? null;
}

function reasoningEffortsForModel(
  info: Pick<LocalChatHarnessInfo, "models" | "reasoning_efforts">,
  modelId?: string | null
) {
  const selectedModel = info.models.find((model) => model.id === modelId);
  const supportedIds = selectedModel?.supported_reasoning_effort_ids;
  if (!supportedIds) return info.reasoning_efforts;
  const supported = new Set(supportedIds);
  return info.reasoning_efforts.filter((effort) => supported.has(effort.id));
}

export function speedTiersForModel(
  info: Pick<LocalChatHarnessInfo, "models" | "speed_tiers" | "default_model_id">,
  modelId?: string | null
) {
  const speedTiers = info.speed_tiers ?? [];
  const selectedModel = info.models.find(
    (model) => model.id === (modelId ?? info.default_model_id)
  );
  const supportedIds = selectedModel?.supported_speed_tier_ids;
  if (supportedIds) {
    const supported = new Set(supportedIds);
    return speedTiers.filter((tier) => supported.has(tier.id));
  }

  const standard = speedTiers.find((tier) => tier.id === "default");
  return standard ? [standard] : speedTiers.slice(0, 1);
}

export function resolveSpeedTierDefault(
  info: Pick<
    LocalChatHarnessInfo,
    "models" | "speed_tiers" | "default_model_id"
  >,
  override?: string,
  modelId?: string | null
): string | null {
  const tiers = speedTiersForModel(info, modelId);
  if (override && tiers.some((tier) => tier.id === override)) return override;
  return tiers.find((tier) => tier.is_default)?.id ?? tiers[0]?.id ?? null;
}

export function hasStaleSpeedTier(
  info: Pick<
    LocalChatHarnessInfo,
    "models" | "speed_tiers" | "default_model_id"
  >,
  override?: string,
  modelId?: string | null
): boolean {
  return (
    !!override &&
    !speedTiersForModel(info, modelId).some((tier) => tier.id === override)
  );
}

export function resolveReasoningEffortDefault(
  info: Pick<
    LocalChatHarnessInfo,
    "models" | "reasoning_efforts" | "default_reasoning_effort"
  >,
  override?: string,
  modelId?: string | null
): string | null {
  const efforts = reasoningEffortsForModel(info, modelId);
  if (override && efforts.some((effort) => effort.id === override)) {
    return override;
  }
  if (
    info.default_reasoning_effort &&
    efforts.some((effort) => effort.id === info.default_reasoning_effort)
  ) {
    return info.default_reasoning_effort;
  }
  return efforts[0]?.id ?? null;
}

export function hasStaleReasoningEffort(
  info: Pick<LocalChatHarnessInfo, "models" | "reasoning_efforts">,
  override?: string,
  modelId?: string | null
): boolean {
  return (
    !!override &&
    !reasoningEffortsForModel(info, modelId).some(
      (effort) => effort.id === override
    )
  );
}

export function resolveDefaultProvider(
  catalog: Pick<LocalChatHarnessCatalog, "default_provider" | "providers">,
  override?: string | null
): LocalChatProviderInfo | null {
  const available = catalog.providers.filter((provider) => provider.available);
  return (
    available.find((provider) => provider.id === override) ??
    available.find((provider) => provider.id === catalog.default_provider) ??
    available[0] ??
    null
  );
}

export function hasStaleModelDefault(
  info: Pick<LocalChatHarnessInfo, "models">,
  override?: string
): boolean {
  return !!override && !info.models.some((model) => model.id === override);
}

export function hasStalePermissionDefault(
  info: Pick<LocalChatHarnessInfo, "permission_modes">,
  override?: PermissionMode
): boolean {
  return (
    !!override &&
    !(info.permission_modes ?? []).some((mode) => mode.id === override)
  );
}

export function personalityOptionsForModel(
  info: Pick<LocalChatHarnessInfo, "harness" | "models" | "personality_options">,
  modelId?: string | null
) {
  const options = info.personality_options ?? [];
  if (info.harness !== "codex") return options;
  const model = info.models.find((candidate) => candidate.id === modelId);
  if (model?.supports_personality === true) return options;
  if (model?.supports_personality === false) {
    return options.filter((option) => option.id === "none");
  }
  return [];
}

export function resolvePersonalityDefault(
  info: Pick<LocalChatHarnessInfo, "harness" | "models" | "personality_options">,
  override?: string,
  modelId?: string | null
): string | null {
  const options = personalityOptionsForModel(info, modelId);
  return override && options.some((option) => option.id === override)
    ? override
    : null;
}

export function hasStalePersonalityDefault(
  info: Pick<LocalChatHarnessInfo, "harness" | "models" | "personality_options">,
  override?: string,
  modelId?: string | null
): boolean {
  return !!override &&
    !personalityOptionsForModel(info, modelId).some(
      (option) => option.id === override
    );
}
