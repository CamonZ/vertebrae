import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalChatHarnessInfo, LocalChatProviderInfo } from "../bindings";
import {
  hasStaleModelDefault,
  hasStalePermissionDefault,
  hasStalePersonalityDefault,
  hasStaleReasoningEffort,
  LEGACY_LOCAL_CHAT_DEFAULTS_STORAGE_KEY,
  LOCAL_CHAT_DEFAULTS_STORAGE_KEY,
  personalityOptionsForModel,
  providerHarnessInfo,
  resolveDefaultProvider,
  resolveModelDefaultId,
  resolvePersonalityDefault,
  resolvePermissionDefault,
  resolveReasoningEffortDefault,
  resolveSpeedTierDefault,
  hasStaleSpeedTier,
  speedTiersForModel,
  useLocalChatDefaultsStore,
} from "./localChatDefaults";

const claudeInfo: LocalChatHarnessInfo = {
  harness: "claude",
  label: "Claude",
  available: true,
  unavailable_reason: null,
  default_model_id: "sonnet",
  models: [
    { id: "sonnet", label: "Sonnet" },
    { id: "opus", label: "Opus" },
  ],
  default_reasoning_effort: null,
  reasoning_efforts: [],
  permission_modes: [
    { id: "default", label: "Ask before edits", is_default: true },
    { id: "plan", label: "Plan mode", is_default: false },
  ],
  personality_options: [
    { id: "Default", label: "Default", is_default: true },
    { id: "Explanatory", label: "Explanatory", is_default: false },
  ],
  supports_resume: true,
};

const codexInfo: LocalChatHarnessInfo = {
  harness: "codex",
  label: "Codex",
  available: true,
  unavailable_reason: null,
  default_model_id: "gpt-5.6-luna",
  models: [
    {
      id: "gpt-5.6-luna",
      label: "GPT-5.6-Luna",
      supported_reasoning_effort_ids: ["medium", "high"],
      supported_speed_tier_ids: ["default", "fast"],
      supports_personality: true,
    },
  ],
  default_reasoning_effort: "medium",
  reasoning_efforts: [
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
  ],
  speed_tiers: [
    { id: "default", label: "Standard", is_default: true },
    { id: "fast", label: "Fast", is_default: false },
  ],
  permission_modes: [],
  personality_options: [
    { id: "friendly", label: "Friendly", is_default: false },
    { id: "pragmatic", label: "Pragmatic", is_default: false },
    { id: "none", label: "None", is_default: false },
  ],
  supports_resume: true,
};

describe("local chat defaults", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useLocalChatDefaultsStore.setState({
      defaults: {},
      defaultProvider: null,
      storageWarning: null,
    });
  });

  it("persists provider-keyed model, effort, speed, and permission overrides", () => {
    useLocalChatDefaultsStore
      .getState()
      .setDefaultProvider({ id: "openrouter", harness: "claude" });
    useLocalChatDefaultsStore.getState().setModelDefault("anthropic", "opus");
    useLocalChatDefaultsStore
      .getState()
      .setReasoningEffortDefault("openai", "high");
    useLocalChatDefaultsStore.getState().setSpeedTierDefault("openai", "fast");
    useLocalChatDefaultsStore
      .getState()
      .setPermissionDefault("anthropic", "plan");
    useLocalChatDefaultsStore
      .getState()
      .setPersonalityDefault("anthropic", "Explanatory");
    useLocalChatDefaultsStore
      .getState()
      .setModelDefault("openrouter", "moonshotai/kimi-k2");

    const expectedDefaults = {
      anthropic: {
        modelId: "opus",
        permissionMode: "plan",
        personality: "Explanatory",
      },
      openai: { reasoningEffort: "high", speedTier: "fast" },
      openrouter: { modelId: "moonshotai/kimi-k2" },
    };
    expect(useLocalChatDefaultsStore.getState().defaults).toEqual(
      expectedDefaults
    );
    expect(useLocalChatDefaultsStore.getState().defaultProvider).toEqual({
      id: "openrouter",
      harness: "claude",
    });
    expect(
      JSON.parse(
        window.localStorage.getItem(LOCAL_CHAT_DEFAULTS_STORAGE_KEY) ?? "{}"
      )
    ).toEqual({
      defaultProvider: { id: "openrouter", harness: "claude" },
      providers: expectedDefaults,
    });
  });

  it("migrates harness-keyed v1 defaults onto the built-in providers", async () => {
    window.localStorage.setItem(
      LEGACY_LOCAL_CHAT_DEFAULTS_STORAGE_KEY,
      JSON.stringify({
        defaultHarness: "codex",
        harnesses: {
          claude: { modelId: "opus" },
          codex: { reasoningEffort: "high" },
        },
      })
    );
    vi.resetModules();
    const fresh = await import("./localChatDefaults");

    expect(fresh.useLocalChatDefaultsStore.getState().defaults).toEqual({
      anthropic: { modelId: "opus" },
      openai: { reasoningEffort: "high" },
    });
    expect(fresh.useLocalChatDefaultsStore.getState().defaultProvider).toEqual({
      id: "openai",
      harness: "codex",
    });
  });

  it("projects custom providers onto their harness with only their models", () => {
    const custom: LocalChatProviderInfo = {
      id: "openrouter",
      label: "openrouter",
      harness: "claude",
      custom: true,
      available: true,
      unavailable_reason: null,
      models: [{ id: "moonshotai/kimi-k2", label: "moonshotai/kimi-k2" }],
      default_model_id: "moonshotai/kimi-k2",
    };
    const builtin: LocalChatProviderInfo = {
      ...custom,
      id: "anthropic",
      label: "Anthropic",
      custom: false,
      models: null,
      default_model_id: "sonnet",
    };
    const catalog = {
      default_provider: "anthropic",
      providers: [builtin, custom],
      harnesses: [claudeInfo, codexInfo],
    };

    const projected = providerHarnessInfo(catalog, custom);
    expect(projected?.models.map((model) => model.id)).toEqual([
      "moonshotai/kimi-k2",
    ]);
    expect(projected?.default_model_id).toBe("moonshotai/kimi-k2");
    expect(projected?.label).toBe("openrouter");
    expect(projected?.permission_modes).toEqual(claudeInfo.permission_modes);
    expect(providerHarnessInfo(catalog, builtin)?.models).toEqual(
      claudeInfo.models
    );
    expect(resolveDefaultProvider(catalog, "openrouter")?.id).toBe("openrouter");
    expect(resolveDefaultProvider(catalog, "missing")?.id).toBe("anthropic");
  });

  it("resolves stale overrides to the provider defaults", () => {
    expect(resolveModelDefaultId(claudeInfo, "missing-model")).toBe("sonnet");
    expect(resolvePermissionDefault(claudeInfo, "dont_ask")).toBe("default");
    expect(hasStaleModelDefault(claudeInfo, "missing-model")).toBe(true);
    expect(hasStalePermissionDefault(claudeInfo, "dont_ask")).toBe(true);
    expect(resolvePersonalityDefault(claudeInfo, "Explanatory")).toBe(
      "Explanatory"
    );
    expect(hasStalePersonalityDefault(claudeInfo, "missing-style")).toBe(true);
    expect(resolveReasoningEffortDefault(codexInfo, "high")).toBe("high");
    expect(resolveReasoningEffortDefault(codexInfo, "missing")).toBe("medium");
    expect(hasStaleReasoningEffort(codexInfo, "missing")).toBe(true);
    expect(speedTiersForModel(codexInfo)).toHaveLength(2);
    expect(resolveSpeedTierDefault(codexInfo, "fast")).toBe("fast");
    expect(resolveSpeedTierDefault(codexInfo, "fast", "missing")).toBe(
      "default"
    );
    expect(hasStaleSpeedTier(codexInfo, "fast", "missing")).toBe(true);
  });

  it("filters Codex personalities by the selected model capability", () => {
    const mixedCodexInfo: LocalChatHarnessInfo = {
      ...codexInfo,
      models: [
        {
          id: "supported",
          label: "Supported",
          supports_personality: true,
        },
        {
          id: "unsupported",
          label: "Unsupported",
          supports_personality: false,
        },
      ],
    };

    expect(
      personalityOptionsForModel(mixedCodexInfo, "supported").map(
        (option) => option.id
      )
    ).toEqual(["friendly", "pragmatic", "none"]);
    expect(
      personalityOptionsForModel(mixedCodexInfo, "unsupported").map(
        (option) => option.id
      )
    ).toEqual(["none"]);
    expect(personalityOptionsForModel(mixedCodexInfo, "unknown")).toEqual([]);
    expect(
      hasStalePersonalityDefault(mixedCodexInfo, "friendly", "unsupported")
    ).toBe(true);
  });

  it("removes an override when reset or cleared", () => {
    useLocalChatDefaultsStore.getState().setModelDefault("anthropic", "opus");
    useLocalChatDefaultsStore.getState().resetProvider("anthropic");
    expect(useLocalChatDefaultsStore.getState().defaults).toEqual({});
    expect(
      JSON.parse(
        window.localStorage.getItem(LOCAL_CHAT_DEFAULTS_STORAGE_KEY) ?? "{}"
      )
    ).toEqual({ defaultProvider: null, providers: {} });
  });
});
