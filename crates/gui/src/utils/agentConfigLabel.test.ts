import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../bindings";
import { formatAgentModelLabel } from "./agentConfigLabel";

function createAgentConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    model: null,
    codex_model_provider: null,
    fallback_model: null,
    reasoning_effort: null,
    speed_tier: null,
    personality: null,
    verbosity: null,
    system_prompt: null,
    append_system_prompt: null,
    agents: null,
    tools: [],
    allowed_tools: [],
    disallowed_tools: [],
    permission_mode: null,
    max_budget_usd: null,
    mcp_config: [],
    plugin_dirs: [],
    json_schema: null,
    ...overrides,
  };
}

describe("formatAgentModelLabel", () => {
  it("returns default when no model is configured", () => {
    expect(formatAgentModelLabel(createAgentConfig())).toBe("default");
  });

  it("returns the model without a suffix when effort is absent", () => {
    expect(formatAgentModelLabel(createAgentConfig({ model: "gpt-5.5" }))).toBe(
      "gpt-5.5"
    );
  });

  it("combines model and effort when both are configured", () => {
    expect(
      formatAgentModelLabel(
        createAgentConfig({ model: "gpt-5.5", reasoning_effort: "medium" })
      )
    ).toBe("gpt-5.5:medium");
  });

  it("does not append effort to the default model label", () => {
    expect(
      formatAgentModelLabel(createAgentConfig({ reasoning_effort: "medium" }))
    ).toBe("default");
  });
});
