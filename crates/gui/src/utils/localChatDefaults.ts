import { create } from "zustand";
import type {
  LocalChatHarnessCatalog,
  LocalChatHarnessInfo,
  LocalChatHarnessKind,
  PermissionMode,
} from "../bindings";

export const LOCAL_CHAT_DEFAULTS_STORAGE_KEY =
  "vertebrae.local-chat-harness-defaults.v1";

export interface LocalChatHarnessDefaults {
  modelId?: string;
  reasoningEffort?: string;
  speedTier?: string;
  permissionMode?: PermissionMode;
}

export type LocalChatDefaults = Partial<
  Record<LocalChatHarnessKind, LocalChatHarnessDefaults>
>;

interface LocalChatDefaultsState {
  defaults: LocalChatDefaults;
  defaultHarness: LocalChatHarnessKind | null;
  storageWarning: string | null;
  setDefaultHarness: (harness: LocalChatHarnessKind | null) => void;
  setModelDefault: (
    harness: LocalChatHarnessKind,
    modelId: string | null
  ) => void;
  setReasoningEffortDefault: (
    harness: LocalChatHarnessKind,
    reasoningEffort: string | null
  ) => void;
  setSpeedTierDefault: (
    harness: LocalChatHarnessKind,
    speedTier: string | null
  ) => void;
  setPermissionDefault: (
    harness: LocalChatHarnessKind,
    permissionMode: PermissionMode | null
  ) => void;
  resetHarness: (harness: LocalChatHarnessKind) => void;
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

function readStoredDefaults(): {
  defaults: LocalChatDefaults;
  defaultHarness: LocalChatHarnessKind | null;
  storageWarning: string | null;
} {
  if (typeof window === "undefined") {
    return { defaults: {}, defaultHarness: null, storageWarning: null };
  }

  try {
    const raw = window.localStorage.getItem(LOCAL_CHAT_DEFAULTS_STORAGE_KEY);
    if (!raw) {
      return { defaults: {}, defaultHarness: null, storageWarning: null };
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        defaults: {},
        defaultHarness: null,
        storageWarning: "Saved defaults were invalid; using harness defaults.",
      };
    }

    const parsedRecord = parsed as Record<string, unknown>;
    const storedHarnesses =
      parsedRecord.harnesses &&
      typeof parsedRecord.harnesses === "object" &&
      !Array.isArray(parsedRecord.harnesses)
        ? parsedRecord.harnesses
        : parsed;
    const defaults: LocalChatDefaults = {};
    for (const [harness, value] of Object.entries(storedHarnesses)) {
      if (!isHarnessKind(harness) || !value || typeof value !== "object") {
        continue;
      }
      const record = value as Record<string, unknown>;
      const modelId =
        typeof record.modelId === "string" && record.modelId.trim()
          ? record.modelId.trim()
          : undefined;
      const reasoningEffort =
        typeof record.reasoningEffort === "string" &&
        record.reasoningEffort.trim()
          ? record.reasoningEffort.trim()
          : undefined;
      const speedTier = isSpeedTier(record.speedTier)
        ? record.speedTier
        : undefined;
      const permissionMode = isPermissionMode(record.permissionMode)
        ? record.permissionMode
        : undefined;
      if (modelId || reasoningEffort || speedTier || permissionMode) {
        defaults[harness] = {
          modelId,
          reasoningEffort,
          speedTier,
          permissionMode,
        };
      }
    }
    const defaultHarness = isHarnessKind(parsedRecord.defaultHarness)
      ? parsedRecord.defaultHarness
      : null;
    return { defaults, defaultHarness, storageWarning: null };
  } catch {
    return {
      defaults: {},
      defaultHarness: null,
      storageWarning:
        "Saved defaults could not be read; using harness defaults.",
    };
  }
}

function writeStoredDefaults(
  defaults: LocalChatDefaults,
  defaultHarness: LocalChatHarnessKind | null
): string | null {
  if (typeof window === "undefined") return null;
  try {
    window.localStorage.setItem(
      LOCAL_CHAT_DEFAULTS_STORAGE_KEY,
      JSON.stringify({ defaultHarness, harnesses: defaults })
    );
    return null;
  } catch {
    // Settings are a convenience. A disabled or unavailable storage backend
    // must not prevent the chat UI from loading.
    return "Defaults could not be saved on this device; they will remain active until the app reloads.";
  }
}

function updateHarnessDefaults(
  defaults: LocalChatDefaults,
  harness: LocalChatHarnessKind,
  update: (current: LocalChatHarnessDefaults) => LocalChatHarnessDefaults
): LocalChatDefaults {
  const nextHarness = update(defaults[harness] ?? {});
  const next = { ...defaults };
  if (Object.keys(nextHarness).length === 0) {
    delete next[harness];
  } else {
    next[harness] = nextHarness;
  }
  return next;
}

export const useLocalChatDefaultsStore = create<LocalChatDefaultsState>(
  (set) => {
    const initial = readStoredDefaults();
    return {
      defaults: initial.defaults,
      defaultHarness: initial.defaultHarness,
      storageWarning: initial.storageWarning,
      setModelDefault: (harness, modelId) =>
        set((state) => {
          const defaults = updateHarnessDefaults(
            state.defaults,
            harness,
            (current) => {
              const next = { ...current };
              if (modelId?.trim()) next.modelId = modelId.trim();
              else delete next.modelId;
              return next;
            }
          );
          return {
            defaults,
            storageWarning: writeStoredDefaults(defaults, state.defaultHarness),
          };
        }),
      setReasoningEffortDefault: (harness, reasoningEffort) =>
        set((state) => {
          const defaults = updateHarnessDefaults(
            state.defaults,
            harness,
            (current) => {
              const next = { ...current };
              if (reasoningEffort?.trim()) {
                next.reasoningEffort = reasoningEffort.trim();
              } else {
                delete next.reasoningEffort;
              }
              return next;
            }
          );
          return {
            defaults,
            storageWarning: writeStoredDefaults(defaults, state.defaultHarness),
          };
        }),
      setSpeedTierDefault: (harness, speedTier) =>
        set((state) => {
          const defaults = updateHarnessDefaults(
            state.defaults,
            harness,
            (current) => {
              const next = { ...current };
              if (isSpeedTier(speedTier)) next.speedTier = speedTier;
              else delete next.speedTier;
              return next;
            }
          );
          return {
            defaults,
            storageWarning: writeStoredDefaults(defaults, state.defaultHarness),
          };
        }),
      setPermissionDefault: (harness, permissionMode) =>
        set((state) => {
          const defaults = updateHarnessDefaults(
            state.defaults,
            harness,
            (current) => {
              const next = { ...current };
              if (permissionMode) next.permissionMode = permissionMode;
              else delete next.permissionMode;
              return next;
            }
          );
          return {
            defaults,
            storageWarning: writeStoredDefaults(defaults, state.defaultHarness),
          };
        }),
      resetHarness: (harness) =>
        set((state) => {
          if (!state.defaults[harness]) return state;
          const defaults = { ...state.defaults };
          delete defaults[harness];
          return {
            defaults,
            storageWarning: writeStoredDefaults(defaults, state.defaultHarness),
          };
        }),
      setDefaultHarness: (defaultHarness) =>
        set((state) => ({
          defaultHarness,
          storageWarning: writeStoredDefaults(state.defaults, defaultHarness),
        })),
    };
  }
);

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

export function resolveDefaultHarness(
  catalog: Pick<LocalChatHarnessCatalog, "default_harness" | "harnesses">,
  override?: LocalChatHarnessKind | null
): LocalChatHarnessKind | null {
  const available = catalog.harnesses.filter((info) => info.available);
  if (override && available.some((info) => info.harness === override)) {
    return override;
  }
  if (available.some((info) => info.harness === catalog.default_harness)) {
    return catalog.default_harness;
  }
  return available[0]?.harness ?? null;
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
