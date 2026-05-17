import type { AgentConfig } from "../bindings";

export function formatAgentModelLabel(agentConfig?: AgentConfig | null): string {
  const model = agentConfig?.model || "default";
  return agentConfig?.model && agentConfig.reasoning_effort
    ? `${model}:${agentConfig.reasoning_effort}`
    : model;
}
