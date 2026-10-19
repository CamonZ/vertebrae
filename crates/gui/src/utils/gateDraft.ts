import type { GateDraft, GateField, JsonValue } from "../bindings";
import type { ChatMessage } from "../stores/chatStore";
import { safeMs } from "../components/Traces/timeUtils";
import { isHiddenTurn } from "./gateChat";

/**
 * Completed user turns without a draft change after which a draftable gate
 * chat is steered: a hidden hint, then an inline form, then an escape card.
 */
export interface GateSteeringThresholds {
  soft: number;
  form: number;
  escape: number;
}

export const DEFAULT_GATE_STEERING_THRESHOLDS: GateSteeringThresholds = {
  soft: 3,
  form: 6,
  escape: 9,
};

export type GateSteeringTier = "none" | "soft" | "form" | "escape";

/** Answers keyed by field name, as Sacrum stores them. */
export type GateDraftValues = Record<string, JsonValue>;

export function draftValues(
  draft: GateDraft | null | undefined
): GateDraftValues {
  const values = draft?.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) return {};
  return values as GateDraftValues;
}

/**
 * When the stall count starts: the latest of the draft's last change, the
 * gate's (re-)entry and a "Keep going" reset. Null when none is known.
 */
export function stallBaselineMs(
  ...instants: (string | number | null | undefined)[]
): number | null {
  let baseline: number | null = null;
  for (const instant of instants) {
    const ms =
      typeof instant === "number" ? instant : instant ? safeMs(instant) : null;
    if (ms !== null && (baseline === null || ms > baseline)) baseline = ms;
  }
  return baseline;
}

/**
 * User turns completed after `sinceMs`. Hidden Vertebrae turns never count,
 * and the user's latest message does not count while its turn is running.
 */
export function stalledUserTurns(
  messages: readonly ChatMessage[],
  sinceMs: number | null,
  turnInProgress: boolean
): number {
  const userTurns = messages.filter(
    (message): message is Extract<ChatMessage, { kind: "user" }> =>
      message.kind === "user" && !isHiddenTurn(message.text)
  );
  const stalled = userTurns.filter((message) => {
    if (sinceMs === null) return true;
    const ms = safeMs(message.timestamp);
    return ms !== null && ms > sinceMs;
  }).length;
  return Math.max(0, stalled - (turnInProgress && stalled > 0 ? 1 : 0));
}

export function steeringTier(
  stalledTurns: number,
  thresholds: GateSteeringThresholds
): GateSteeringTier {
  if (stalledTurns >= thresholds.escape) return "escape";
  if (stalledTurns >= thresholds.form) return "form";
  if (stalledTurns >= thresholds.soft) return "soft";
  return "none";
}

/** Fields the draft still needs: missing ones and ones with invalid values. */
export function remainingFields(
  fields: readonly GateField[],
  draft: GateDraft | null | undefined
): GateField[] {
  if (!draft || draft.complete) return [];
  const invalid = new Set(
    draft.invalid.map((violation) => fieldOfPath(violation.path))
  );
  const missing = new Set(draft.missing);
  return fields.filter(
    (field) => missing.has(field.name) || invalid.has(field.name)
  );
}

/** The top-level field a JSON pointer such as `/approved/0` points into. */
export function fieldOfPath(path: string): string {
  return path.replace(/^\//, "").split("/")[0] ?? "";
}

function describeField(field: GateField): string {
  return field.question ? `${field.name} (${field.question})` : field.name;
}

/** Hidden turn steering a stalled conversation back to the gate. */
export function steeringHintText(fields: readonly GateField[]): string {
  return `[Vertebrae steering] Still needed: ${fields.map(describeField).join("; ")}. Acknowledge what the user said, then steer back to these.`;
}

/** Hidden turn reporting answers the user gave in the inline form. */
export function formAnsweredText(
  fields: readonly GateField[],
  values: GateDraftValues
): string {
  const answered = fields
    .filter((field) => field.name in values)
    .map((field) => `${field.name}: ${JSON.stringify(values[field.name])}`);
  return `[Vertebrae form] The user answered: ${answered.join("; ")}.`;
}

export type GateFieldControl =
  | "choice"
  | "multi"
  | "boolean"
  | "number"
  | "integer"
  | "text"
  | "unsupported";

export function fieldControl(field: GateField): GateFieldControl {
  if (field.multiple) return "multi";
  if (field.choices && field.choices.length > 0) return "choice";
  switch (field.value_type) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "integer":
      return "integer";
    case "string":
    case null:
      return "text";
    default:
      return "unsupported";
  }
}

/** What a form control holds before it becomes a JSON answer. */
export type GateFormInput = string | string[] | boolean | null;

export function initialFormInput(
  field: GateField,
  value: JsonValue | undefined
): GateFormInput {
  switch (fieldControl(field)) {
    case "multi":
      return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
    case "boolean":
      return typeof value === "boolean" ? value : null;
    case "number":
    case "integer":
      return typeof value === "number" ? String(value) : "";
    default:
      return typeof value === "string" ? value : "";
  }
}

export type GateFormParse =
  | { kind: "answered"; value: JsonValue }
  | { kind: "unanswered" }
  | { kind: "error"; message: string };

/** Turn a control's input into the field's JSON answer. */
export function parseFormInput(
  field: GateField,
  input: GateFormInput
): GateFormParse {
  switch (fieldControl(field)) {
    case "multi":
      return Array.isArray(input) && input.length > 0
        ? { kind: "answered", value: input }
        : { kind: "unanswered" };
    case "boolean":
      return typeof input === "boolean"
        ? { kind: "answered", value: input }
        : { kind: "unanswered" };
    case "number":
    case "integer": {
      const text = typeof input === "string" ? input.trim() : "";
      if (!text) return { kind: "unanswered" };
      const number = Number(text);
      if (!Number.isFinite(number)) {
        return { kind: "error", message: "Enter a number." };
      }
      if (fieldControl(field) === "integer" && !Number.isInteger(number)) {
        return { kind: "error", message: "Enter a whole number." };
      }
      return { kind: "answered", value: number };
    }
    default: {
      const text = typeof input === "string" ? input : "";
      return text.trim()
        ? { kind: "answered", value: text }
        : { kind: "unanswered" };
    }
  }
}

/** A recorded answer as the user reads it. */
export function formatDraftValue(value: JsonValue): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(formatDraftValue).join(", ");
  return JSON.stringify(value);
}
