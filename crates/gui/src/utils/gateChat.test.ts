import { describe, expect, it } from "vitest";
import type { StepExecution, TaskRun } from "../bindings";
import {
  GATE_CHAT_KICKOFF,
  gateChatBinding,
  gateChatLabel,
  hiddenTurn,
  isHiddenTurn,
  isSameGate,
} from "./gateChat";
import type { HumanInputGateContext } from "./humanInputGate";

function context(
  overrides: Partial<HumanInputGateContext> = {}
): HumanInputGateContext {
  return {
    run: { id: "run-1" } as TaskRun,
    execution: { id: "exec-1" } as StepExecution,
    stepName: "approve",
    prompt: "Ship v2?",
    outputSchema: { type: "object" },
    artifact: "approval",
    ...overrides,
  };
}

describe("gateChatBinding", () => {
  it("binds the run's step to the waiting execution's rendered config", () => {
    expect(gateChatBinding(context())).toEqual({
      task_run_id: "run-1",
      step_name: "approve",
      execution_id: "exec-1",
      artifact: "approval",
      instructions: "Ship v2?",
      output_schema: { type: "object" },
    });
  });

  it("keeps a gate without a question or schema resolvable", () => {
    expect(
      gateChatBinding(context({ prompt: null, outputSchema: null }))
    ).toMatchObject({ instructions: null, output_schema: null });
  });

  it("is null when the gate cannot be resolved by artifact", () => {
    for (const overrides of [
      { artifact: null },
      { artifact: "  " },
      { execution: null },
      { execution: { id: null } as StepExecution },
      { stepName: null },
    ]) {
      expect(gateChatBinding(context(overrides))).toBeNull();
    }
  });
});

describe("gate chat helpers", () => {
  it("matches gates by run and step, not execution", () => {
    const gate = gateChatBinding(context())!;
    const reentered = gateChatBinding(
      context({ execution: { id: "exec-2" } as StepExecution })
    )!;
    expect(isSameGate(gate, reentered)).toBe(true);
    expect(isSameGate(gate, { ...gate, step_name: "review" })).toBe(false);
    expect(isSameGate(gate, { ...gate, task_run_id: "run-2" })).toBe(false);
  });

  it("marks injected turns as hidden", () => {
    expect(isHiddenTurn(GATE_CHAT_KICKOFF)).toBe(true);
    expect(isHiddenTurn(`  ${hiddenTurn("verdict")}`)).toBe(true);
    expect(isHiddenTurn("Ship it")).toBe(false);
  });

  it("labels gate chats by step", () => {
    expect(gateChatLabel("approve")).toBe("Resolve approve");
  });
});
