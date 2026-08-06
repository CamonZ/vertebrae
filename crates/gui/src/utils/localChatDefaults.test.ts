import { beforeEach, describe, expect, it } from "vitest";
import type { LocalChatHarnessInfo } from "../bindings";
import {
  hasStaleModelDefault,
  hasStalePermissionDefault,
  hasStaleReasoningEffort,
  LOCAL_CHAT_DEFAULTS_STORAGE_KEY,
  resolveModelDefaultId,
  resolvePermissionDefault,
  resolveReasoningEffortDefault,
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
    },
  ],
  default_reasoning_effort: "medium",
  reasoning_efforts: [
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
  ],
  permission_modes: [],
  supports_resume: true,
};

describe("local chat defaults", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useLocalChatDefaultsStore.setState({
      defaults: {},
      defaultHarness: null,
      storageWarning: null,
    });
  });

  it("persists harness, model, effort, and permission overrides", () => {
    useLocalChatDefaultsStore.getState().setDefaultHarness("codex");
    useLocalChatDefaultsStore.getState().setModelDefault("claude", "opus");
    useLocalChatDefaultsStore
      .getState()
      .setReasoningEffortDefault("codex", "high");
    useLocalChatDefaultsStore.getState().setPermissionDefault("claude", "plan");

    expect(useLocalChatDefaultsStore.getState().defaults).toEqual({
      claude: { modelId: "opus", permissionMode: "plan" },
      codex: { reasoningEffort: "high" },
    });
    expect(useLocalChatDefaultsStore.getState().defaultHarness).toBe("codex");
    expect(
      JSON.parse(
        window.localStorage.getItem(LOCAL_CHAT_DEFAULTS_STORAGE_KEY) ?? "{}"
      )
    ).toEqual({
      defaultHarness: "codex",
      harnesses: {
        claude: { modelId: "opus", permissionMode: "plan" },
        codex: { reasoningEffort: "high" },
      },
    });
  });

  it("resolves stale overrides to the provider defaults", () => {
    expect(resolveModelDefaultId(claudeInfo, "missing-model")).toBe("sonnet");
    expect(resolvePermissionDefault(claudeInfo, "dont_ask")).toBe("default");
    expect(hasStaleModelDefault(claudeInfo, "missing-model")).toBe(true);
    expect(hasStalePermissionDefault(claudeInfo, "dont_ask")).toBe(true);
    expect(resolveReasoningEffortDefault(codexInfo, "high")).toBe("high");
    expect(resolveReasoningEffortDefault(codexInfo, "missing")).toBe("medium");
    expect(hasStaleReasoningEffort(codexInfo, "missing")).toBe(true);
  });

  it("removes an override when reset or cleared", () => {
    useLocalChatDefaultsStore.getState().setModelDefault("claude", "opus");
    useLocalChatDefaultsStore.getState().resetHarness("claude");
    expect(useLocalChatDefaultsStore.getState().defaults).toEqual({});
    expect(
      JSON.parse(
        window.localStorage.getItem(LOCAL_CHAT_DEFAULTS_STORAGE_KEY) ?? "{}"
      )
    ).toEqual({ defaultHarness: null, harnesses: {} });
  });
});
