import { describe, expect, it } from "vitest";
import type { StepExecution, TaskRun } from "../bindings";
import {
  GATE_CHAT_KICKOFF,
  deriveGateChatStatus,
  gateChatAcceptsSubmission,
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

describe("deriveGateChatStatus", () => {
  const gate = { task_run_id: "run-1", step_name: "approve" };
  const at = (second: number) =>
    new Date(Date.UTC(2026, 9, 18, 12, 0, second)).toISOString();

  function run(status: TaskRun["status"]): TaskRun {
    return { id: "run-1", status } as TaskRun;
  }

  function exec(
    id: string,
    stepName: string,
    stepType: string,
    startedAt: number,
    completedAt: number | null = null
  ): StepExecution {
    return {
      id,
      task_run_id: "run-1",
      step_name: stepName,
      step_type: stepType,
      started_at: at(startedAt),
      completed_at: completedAt === null ? null : at(completedAt),
    };
  }

  const firstAttempt = exec("gate-1", "approve", "human_input", 0);
  const submitted = exec("gate-1", "approve", "human_input", 0, 5);
  const evaluated = exec("eval-1", "review", "structured_inference", 6, 8);
  const routed = exec("route-1", "decide", "route", 9, 10);

  it("drafts while the first attempt waits", () => {
    expect(deriveGateChatStatus(gate, run("waiting"), [firstAttempt])).toEqual({
      phase: "drafting",
      attempt: 1,
      waitingExecutionId: "gate-1",
    });
  });

  it("is under review once the submission completes the attempt", () => {
    expect(
      deriveGateChatStatus(gate, run("executing"), [submitted, evaluated])
    ).toEqual({ phase: "under_review", attempt: 1, waitingExecutionId: null });
  });

  it("is rejected at attempt n when the route loops back to the gate", () => {
    const status = deriveGateChatStatus(gate, run("waiting"), [
      exec("gate-2", "approve", "human_input", 11),
      submitted,
      evaluated,
      routed,
    ]);

    expect(status).toEqual({
      phase: "rejected",
      attempt: 2,
      waitingExecutionId: "gate-2",
    });
    expect(gateChatAcceptsSubmission(status)).toBe(true);
  });

  it("is accepted when the route sends the run to another step", () => {
    expect(
      deriveGateChatStatus(gate, run("executing"), [
        submitted,
        evaluated,
        routed,
        exec("ship-1", "ship", "llm_inference", 11),
      ])
    ).toEqual({ phase: "accepted", attempt: 1, waitingExecutionId: null });
  });

  it("stays under review through chained routes and steps before the route", () => {
    expect(
      deriveGateChatStatus(gate, run("executing"), [
        submitted,
        evaluated,
        routed,
        exec("route-2", "again", "route", 11),
      ])
    ).toMatchObject({ phase: "under_review" });
  });

  it("closes when the run stops, fails or finishes", () => {
    for (const status of [
      "stopping",
      "stopped",
      "failed",
      "completed",
    ] as const) {
      const closed = deriveGateChatStatus(gate, run(status), [firstAttempt]);
      expect(closed).toEqual({
        phase: "closed",
        attempt: 1,
        waitingExecutionId: null,
      });
      expect(gateChatAcceptsSubmission(closed)).toBe(false);
    }
  });

  it("ignores other runs and runs that never reached the gate", () => {
    expect(
      deriveGateChatStatus(
        gate,
        { id: "run-2", status: "waiting" } as TaskRun,
        [firstAttempt]
      )
    ).toBeNull();
    expect(
      deriveGateChatStatus(gate, run("executing"), [evaluated])
    ).toBeNull();
    expect(gateChatAcceptsSubmission(null)).toBe(true);
  });
});
