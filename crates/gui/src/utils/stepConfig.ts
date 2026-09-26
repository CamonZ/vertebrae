import type {
  JsonValue,
  LlmInferenceStepConfig,
  StepExecution,
  StructuredInferenceStepConfig,
} from "../bindings";

/**
 * Parse a structured_inference `state` input the way the CLI does: JSON
 * objects, arrays, and strings are decoded; anything else is kept as a string
 * template (it may hold `{{ dotted.path }}` references).
 */
export function parseStateInput(text: string): JsonValue {
  try {
    const parsed = JSON.parse(text) as JsonValue;
    if (typeof parsed === "string" || typeof parsed === "object") {
      if (parsed !== null) return parsed;
    }
  } catch {
    // not JSON — a string template
  }
  return text;
}

export function formatStateInput(state: JsonValue | null | undefined): string {
  if (state === null || state === undefined) return "";
  return typeof state === "string" ? state : JSON.stringify(state, null, 2);
}

export function executionPrompt(
  execution: StepExecution | null | undefined
): string | null {
  if (execution?.step_type !== "llm_inference") return null;
  return (execution.config as LlmInferenceStepConfig | null)?.prompt ?? null;
}

export function executionStructuredInference(
  execution: StepExecution | null | undefined
): StructuredInferenceStepConfig | null {
  if (execution?.step_type !== "structured_inference") return null;
  return (execution.config as StructuredInferenceStepConfig | null) ?? null;
}

export function structuredInferenceMeta(
  execution: StepExecution | null | undefined
): unknown {
  if (execution?.step_type !== "structured_inference" || !execution.context) {
    return null;
  }
  try {
    const context = JSON.parse(execution.context) as {
      structured_inference?: { meta?: unknown };
    };
    return context?.structured_inference?.meta ?? null;
  } catch {
    return null;
  }
}

export interface StructuredInferenceInput {
  provider: string;
  model: string;
  state: string;
  fields: string;
}

export const EMPTY_STRUCTURED_INPUT: StructuredInferenceInput = {
  provider: "",
  model: "",
  state: "",
  fields: "",
};

export function structuredInferenceInput(
  config: StructuredInferenceStepConfig | null | undefined
): StructuredInferenceInput {
  return {
    provider: config?.provider ?? "",
    model: config?.model ?? "",
    state: formatStateInput(config?.state),
    fields: config?.fields ? JSON.stringify(config.fields, null, 2) : "",
  };
}

export function structuredInferenceConfig(
  input: StructuredInferenceInput
): { config: Record<string, JsonValue> } | { error: string } {
  if (
    !input.provider.trim() ||
    !input.model.trim() ||
    !input.state.trim() ||
    !input.fields.trim()
  ) {
    return {
      error:
        "Structured inference steps require provider, model, state, and fields.",
    };
  }
  let fields: JsonValue;
  try {
    fields = JSON.parse(input.fields) as JsonValue;
  } catch {
    return { error: "Fields must be a valid JSON Schema." };
  }
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
    return { error: "Fields must be a valid JSON Schema." };
  }
  return {
    config: {
      provider: input.provider.trim(),
      model: input.model.trim(),
      state: parseStateInput(input.state),
      fields,
    },
  };
}
