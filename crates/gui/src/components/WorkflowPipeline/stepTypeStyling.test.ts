import { describe, expect, it } from "vitest";
import {
  hearthStepStyle,
  hearthStepKind,
  stepTypeStyle,
  normalizeStepType,
} from "./stepTypeStyling";

describe("normalizeStepType", () => {
  it.each([
    ["execute", "execute"],
    ["evaluate", "evaluate"],
    ["route", "route"],
    ["human_input", "human_input"],
    ["wait_children", "wait_children"],
    ["finish", "finish"],
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
    expect(stepTypeStyle("finish").barVar).toBe("--color-step-finish");
  });

  it("falls back to a neutral style for unknown kinds", () => {
    const style = stepTypeStyle(null);
    expect(style.kind).toBe("unknown");
    expect(style.hearthKind).toBe("unknown");
    expect(style.barVar).toBe("--color-line-strong");
  });
});

describe("hearthStepKind", () => {
  it.each([
    ["execute", "execute"],
    ["evaluate", "eval"],
    ["route", "route"],
    ["human_input", "human"],
    ["wait_children", "wait"],
    ["finish", "finish"],
  ] as const)("maps production %s to Hearth %s", (input, expected) => {
    expect(hearthStepKind(input)).toBe(expected);
  });
});

describe("hearthStepStyle", () => {
  it("reuses the canonical step palette for v2 Hearth kinds", () => {
    expect(hearthStepStyle("eval")).toMatchObject({
      label: "Evaluate",
      barVar: "--color-step-eval",
      washVar: "--color-step-eval-wash",
      fgVar: "--color-step-eval-fg",
    });
  });
});
