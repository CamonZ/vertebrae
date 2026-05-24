import { describe, expect, it } from "vitest";
import { stepTypeStyle, normalizeStepType } from "./stepTypeStyling";

describe("normalizeStepType", () => {
  it.each([
    ["execute", "execute"],
    ["evaluate", "evaluate"],
    ["route", "route"],
    ["human_input", "human_input"],
    ["wait_children", "wait_children"],
  ] as const)("passes %s through", (input, expected) => {
    expect(normalizeStepType(input)).toBe(expected);
  });

  it("maps null / undefined / objects to unknown", () => {
    expect(normalizeStepType(null)).toBe("unknown");
    expect(normalizeStepType(undefined)).toBe("unknown");
    expect(normalizeStepType({ unsupported: "future" })).toBe("unknown");
  });
});

describe("stepTypeStyle", () => {
  it("returns the matching style for each kind", () => {
    expect(stepTypeStyle("execute").barVar).toBe("--color-step-execute");
    expect(stepTypeStyle("evaluate").barVar).toBe("--color-step-eval");
    expect(stepTypeStyle("route").barVar).toBe("--color-step-route");
    expect(stepTypeStyle("human_input").barVar).toBe("--color-step-human");
    expect(stepTypeStyle("wait_children").barVar).toBe("--color-step-wait");
  });

  it("falls back to a neutral style for unknown kinds", () => {
    const style = stepTypeStyle(null);
    expect(style.kind).toBe("unknown");
    expect(style.barVar).toBe("--color-line-strong");
  });
});
