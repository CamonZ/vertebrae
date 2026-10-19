import { describe, expect, it } from "vitest";
import type { GateDraft, GateField } from "../bindings";
import type { ChatMessage } from "../stores/chatStore";
import { hiddenTurn } from "./gateChat";
import {
  DEFAULT_GATE_STEERING_THRESHOLDS,
  fieldControl,
  formAnsweredText,
  formatDraftValue,
  initialFormInput,
  parseFormInput,
  remainingFields,
  stallBaselineMs,
  stalledUserTurns,
  steeringHintText,
  steeringTier,
} from "./gateDraft";

function field(overrides: Partial<GateField> & { name: string }): GateField {
  return {
    required: true,
    type: "string",
    question: null,
    value_type: "string",
    choices: null,
    multiple: false,
    format: null,
    ...overrides,
  };
}

function draft(overrides: Partial<GateDraft> = {}): GateDraft {
  return {
    execution_id: "exec-1",
    values: {},
    missing: [],
    invalid: [],
    complete: false,
    updated_at: null,
    ...overrides,
  };
}

const at = (second: number) =>
  new Date(Date.UTC(2026, 9, 19, 12, 0, second)).toISOString();
const user = (second: number, text = "hi"): ChatMessage => ({
  kind: "user",
  text,
  timestamp: at(second),
});
const assistant = (second: number): ChatMessage => ({
  kind: "assistant",
  text: "ok",
  timestamp: at(second),
});

describe("stalledUserTurns", () => {
  const messages = [user(1), assistant(2), user(3), assistant(4), user(5)];

  it("counts user turns after the baseline", () => {
    expect(stalledUserTurns(messages, Date.parse(at(2)), false)).toBe(2);
    expect(stalledUserTurns(messages, null, false)).toBe(3);
  });

  it("does not count the turn still running", () => {
    expect(stalledUserTurns(messages, Date.parse(at(2)), true)).toBe(1);
    expect(stalledUserTurns(messages, Date.parse(at(9)), true)).toBe(0);
  });

  it("never counts hidden Vertebrae turns", () => {
    expect(
      stalledUserTurns(
        [user(3), user(4, hiddenTurn("[Vertebrae steering] Still needed"))],
        null,
        false
      )
    ).toBe(1);
  });
});

describe("stallBaselineMs", () => {
  it("takes the latest of the draft change, gate entry and reset", () => {
    expect(stallBaselineMs(at(5), at(2), Date.parse(at(7)))).toBe(
      Date.parse(at(7))
    );
    expect(stallBaselineMs(at(5), at(2), null)).toBe(Date.parse(at(5)));
    expect(stallBaselineMs(null, undefined, null)).toBeNull();
  });
});

describe("steeringTier", () => {
  it("escalates soft, form, then escape at the default thresholds", () => {
    const tiers = [0, 2, 3, 5, 6, 8, 9, 20].map((turns) =>
      steeringTier(turns, DEFAULT_GATE_STEERING_THRESHOLDS)
    );
    expect(tiers).toEqual([
      "none",
      "none",
      "soft",
      "soft",
      "form",
      "form",
      "escape",
      "escape",
    ]);
  });
});

describe("remainingFields", () => {
  const fields = [
    field({ name: "approved", value_type: "boolean" }),
    field({ name: "reason" }),
    field({ name: "notes", required: false }),
  ];

  it("keeps missing and invalid fields in schema order", () => {
    expect(
      remainingFields(
        fields,
        draft({
          missing: ["reason"],
          invalid: [{ path: "/approved", message: "Type mismatch." }],
        })
      ).map((field) => field.name)
    ).toEqual(["approved", "reason"]);
  });

  it("is empty for a complete or absent draft", () => {
    expect(remainingFields(fields, draft({ complete: true }))).toEqual([]);
    expect(remainingFields(fields, null)).toEqual([]);
  });
});

describe("steering texts", () => {
  const fields = [
    field({ name: "reason", question: "Why ship now?" }),
    field({ name: "channel" }),
  ];

  it("lists what is still needed with each field's question", () => {
    expect(steeringHintText(fields)).toBe(
      "[Vertebrae steering] Still needed: reason (Why ship now?); channel. Acknowledge what the user said, then steer back to these."
    );
  });

  it("reports the answers the user gave in the form", () => {
    expect(
      formAnsweredText(fields, { reason: "It is ready", channel: "beta" })
    ).toBe(
      '[Vertebrae form] The user answered: reason: "It is ready"; channel: "beta".'
    );
  });
});

describe("form inputs", () => {
  it("picks a control from the field's structure", () => {
    expect(fieldControl(field({ name: "a", choices: ["x"] }))).toBe("choice");
    expect(
      fieldControl(
        field({
          name: "b",
          value_type: "array",
          choices: ["x"],
          multiple: true,
        })
      )
    ).toBe("multi");
    expect(fieldControl(field({ name: "c", value_type: "boolean" }))).toBe(
      "boolean"
    );
    expect(fieldControl(field({ name: "d", value_type: "integer" }))).toBe(
      "integer"
    );
    expect(fieldControl(field({ name: "e", value_type: "number" }))).toBe(
      "number"
    );
    expect(fieldControl(field({ name: "f", value_type: "object" }))).toBe(
      "unsupported"
    );
  });

  it("parses numbers, rejecting fractions for integers", () => {
    const count = field({ name: "count", value_type: "integer" });
    expect(parseFormInput(count, "3")).toEqual({ kind: "answered", value: 3 });
    expect(parseFormInput(count, "2.5")).toEqual({
      kind: "error",
      message: "Enter a whole number.",
    });
    expect(parseFormInput(count, " ")).toEqual({ kind: "unanswered" });
    expect(
      parseFormInput(field({ name: "x", value_type: "number" }), "abc")
    ).toEqual({
      kind: "error",
      message: "Enter a number.",
    });
  });

  it("treats empty selections and text as unanswered", () => {
    const regions = field({
      name: "r",
      value_type: "array",
      choices: ["eu"],
      multiple: true,
    });
    expect(parseFormInput(regions, [])).toEqual({ kind: "unanswered" });
    expect(parseFormInput(regions, ["eu"])).toEqual({
      kind: "answered",
      value: ["eu"],
    });
    expect(parseFormInput(field({ name: "t" }), "")).toEqual({
      kind: "unanswered",
    });
    expect(
      parseFormInput(field({ name: "b", value_type: "boolean" }), false)
    ).toEqual({
      kind: "answered",
      value: false,
    });
  });

  it("starts from the recorded answer", () => {
    expect(
      initialFormInput(field({ name: "n", value_type: "number" }), 4)
    ).toBe("4");
    expect(
      initialFormInput(field({ name: "b", value_type: "boolean" }), undefined)
    ).toBeNull();
  });

  it("formats recorded answers for reading", () => {
    expect(formatDraftValue(true)).toBe("Yes");
    expect(formatDraftValue(["eu", "us"])).toBe("eu, us");
    expect(formatDraftValue(3)).toBe("3");
  });
});
