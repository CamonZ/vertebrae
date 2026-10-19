import { describe, expect, it } from "vitest";
import type { StepExecution, TaskRun } from "../bindings";
import {
  GATE_CHAT_KICKOFF,
  deriveGateChatStatus,
  gateChatAcceptsSubmission,
  gateChatBinding,
  gateChatLabel,
  parseGateDraftCommand,
  parseGateDraftSubmission,
  parseGateResolutionSubmission,
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
    role: "Release manager",
    question: "Ship v2?",
    outputSchema: { type: "object" },
    artifact: "approval",
    attempt: 1,
    ...overrides,
  };
}

describe("parseGateDraftCommand", () => {
  it("reads set, show and submit for an execution", () => {
    expect(
      parseGateDraftCommand(
        `vtb gate set exec-1 --values '{"approved":true,"note":"it'\\''s fine"}'`
      )
    ).toEqual({
      action: "set",
      executionId: "exec-1",
      values: { approved: true, note: "it's fine" },
    });
    expect(parseGateDraftCommand("vtb --json gate show exec-1")).toEqual({
      action: "show",
      executionId: "exec-1",
    });
    expect(parseGateDraftCommand(`bash -lc "vtb gate submit exec-1"`)).toEqual({
      action: "submit",
      executionId: "exec-1",
    });
  });

  it("ignores other commands and malformed gate commands", () => {
    for (const command of [
      "vtb artifact add a.json",
      "vtb gate set exec-1",
      "vtb gate set exec-1 --values '[1]'",
      "vtb gate submit exec-1 --values '{}'",
      "vtb gate show",
      "vtb gate delete exec-1",
    ]) {
      expect(parseGateDraftCommand(command)).toBeNull();
    }
  });
});

describe("gateChatBinding", () => {
  it("binds the run's step to the waiting execution's rendered config", () => {
    expect(gateChatBinding(context())).toEqual({
      task_run_id: "run-1",
      step_name: "approve",
      execution_id: "exec-1",
      artifact: "approval",
      role: "Release manager",
      question: "Ship v2?",
      output_schema: { type: "object" },
      revision: null,
      fields: null,
    });
  });

  it("keeps a gate without a question or schema resolvable", () => {
    expect(
      gateChatBinding(context({ question: null, outputSchema: null }))
    ).toMatchObject({ question: null, output_schema: null });
  });

  it("derives a revision from a rejected gate's handoff", () => {
    expect(
      gateChatBinding(
        context({
          attempt: 2,
          execution: {
            id: "exec-2",
            handoff: '{"reasons":"The rollback plan is missing."}',
          } as StepExecution,
        })
      )
    ).toMatchObject({
      execution_id: "exec-2",
      revision: {
        attempt: 2,
        verdict: { reasons: "The rollback plan is missing." },
      },
    });
  });

  it("keeps a revision and its raw handoff when the handoff is malformed JSON", () => {
    expect(
      gateChatBinding(
        context({
          attempt: 2,
          execution: {
            id: "exec-2",
            handoff: "The rollback plan is missing.",
          } as StepExecution,
        })
      )
    ).toMatchObject({
      revision: {
        attempt: 2,
        verdict: "The rollback plan is missing.",
      },
    });
  });

  it("keeps a rejected revision when its handoff is missing", () => {
    expect(
      gateChatBinding(
        context({
          attempt: 2,
          execution: { id: "exec-2" } as StepExecution,
        })
      )
    ).toMatchObject({ revision: { attempt: 2, verdict: null } });
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

  it("matches submissions for any execution of the bound gate", () => {
    const gate = gateChatBinding(context())!;
    const command =
      "vtb artifact add approval.json --subject-type step_execution --subject-id exec-2 --logical-name approval --body '{\"approved\":true}'";

    expect(parseGateResolutionSubmission(command, gate)).toEqual({
      artifact: "approval",
      executionId: "exec-2",
      values: { approved: true },
    });
    expect(
      parseGateResolutionSubmission(
        command.replace("approval.json", "other.json"),
        gate
      )
    ).toBeNull();
  });

  it("parses the prompt-prescribed apostrophe quoting", () => {
    const gate = gateChatBinding(context())!;
    const command =
      "vtb artifact add approval.json --subject-type step_execution --subject-id exec-2 --logical-name approval --body '{\"answer\":\"don'\\''t ship\"}'";

    expect(parseGateResolutionSubmission(command, gate)).toEqual({
      artifact: "approval",
      executionId: "exec-2",
      values: { answer: "don't ship" },
    });
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
      waitingSince: at(0),
      draftUpdatedAt: null,
    });
  });

  it("carries when the waiting attempt's draft last changed", () => {
    expect(
      deriveGateChatStatus(gate, run("waiting"), [
        { ...firstAttempt, draft_updated_at: at(3) },
      ])
    ).toMatchObject({ waitingSince: at(0), draftUpdatedAt: at(3) });
  });

  it("is under review once the submission completes the attempt", () => {
    expect(
      deriveGateChatStatus(gate, run("executing"), [submitted, evaluated])
    ).toEqual({
      phase: "under_review",
      attempt: 1,
      waitingExecutionId: null,
      waitingSince: null,
      draftUpdatedAt: null,
    });
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
      waitingSince: at(11),
      draftUpdatedAt: null,
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
    ).toEqual({
      phase: "accepted",
      attempt: 1,
      waitingExecutionId: null,
      waitingSince: null,
      draftUpdatedAt: null,
    });
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
        waitingSince: null,
        draftUpdatedAt: null,
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

describe("parseGateDraftSubmission", () => {
  it("uses only a complete response for the submitted execution", () => {
    const snapshot = {
      execution_id: "exec-1",
      complete: true,
      values: { approved: false },
    };
    expect(
      parseGateDraftSubmission(JSON.stringify(snapshot), "exec-1", "approval")
    ).toEqual({
      executionId: "exec-1",
      artifact: "approval",
      values: snapshot.values,
    });
    for (const output of [
      "Submitted successfully",
      "{}",
      JSON.stringify({ ...snapshot, complete: false }),
      JSON.stringify({ ...snapshot, execution_id: "exec-other" }),
    ]) {
      expect(parseGateDraftSubmission(output, "exec-1", "approval")).toBeNull();
    }
  });
});
