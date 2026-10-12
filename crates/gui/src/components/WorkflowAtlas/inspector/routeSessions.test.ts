import { describe, expect, it } from "vitest";
import {
  childSessionEntriesFor,
  routeDecisions,
  routeTransitionLabels,
  sessionEntriesFor,
  transitionSessionEntriesFor,
  transitionSessionLabels,
} from "./routeSessions";

describe("routeDecisions", () => {
  it("reads rules in order, then the default, with their directives", () => {
    const decisions = routeDecisions({
      rules: [
        {
          id: "again",
          transition: { type: "intra_workflow", step_id: "a" },
          session: { mode: "resume", step_id: "b" },
        },
        {
          id: "out",
          transition: { type: "inter_workflow", workflow_id: "wf-2" },
        },
      ],
      default: {
        transition: { type: "intra_workflow", step_id: "c" },
        session: { mode: "new" },
      },
    });
    expect(decisions).toEqual([
      {
        key: "rule-0",
        label: "again",
        targetStepId: "a",
        targetWorkflowId: null,
        session: { mode: "resume", stepId: "b" },
      },
      {
        key: "rule-1",
        label: "out",
        targetStepId: null,
        targetWorkflowId: "wf-2",
        session: null,
      },
      {
        key: "default",
        label: "default",
        targetStepId: "c",
        targetWorkflowId: null,
        session: { mode: "new", stepId: null },
      },
    ]);
  });

  it("tolerates drafts and malformed values without inventing directives", () => {
    expect(routeDecisions(null)).toEqual([]);
    expect(routeDecisions([])).toEqual([]);
    const [rule] = routeDecisions({
      rules: [{ transition: "bad", session: { mode: "continue" } }, "junk"],
      default: null,
    });
    expect(rule).toEqual({
      key: "rule-0",
      label: "#0",
      targetStepId: null,
      targetWorkflowId: null,
      session: null,
    });
  });
});

describe("sessionEntriesFor", () => {
  const routes = [
    {
      routeStepId: "route",
      routeConfig: {
        rules: [
          {
            id: "loop",
            transition: { type: "intra_workflow", step_id: "a" },
            session: { mode: "resume" },
          },
          {
            id: "branch",
            transition: { type: "intra_workflow", step_id: "b" },
            session: { mode: "fork", step_id: "a" },
          },
          {
            id: "other",
            transition: { type: "intra_workflow", step_id: "c" },
          },
        ],
      },
    },
  ];

  it("separates decisions entering the step from those continuing its conversation", () => {
    expect(
      sessionEntriesFor("a", routes).map((entry) => [
        entry.decision.label,
        entry.role,
      ])
    ).toEqual([
      ["loop", "destination"],
      ["branch", "source"],
    ]);
    expect(sessionEntriesFor("b", routes).map((entry) => entry.role)).toEqual([
      "destination",
    ]);
    expect(sessionEntriesFor("z", routes)).toEqual([]);
  });
});

describe("routeTransitionLabels", () => {
  it("joins every decision taking an edge, naming implicit entries new", () => {
    const labels = routeTransitionLabels({
      rules: [
        {
          id: "loop",
          transition: { type: "intra_workflow", step_id: "a" },
          session: { mode: "resume" },
        },
        { id: "plain", transition: { type: "intra_workflow", step_id: "a" } },
        { id: "out", transition: { type: "inter_workflow", workflow_id: "w" } },
      ],
      default: {
        transition: { type: "intra_workflow", step_id: "b" },
        session: { mode: "fork" },
      },
    });
    expect([...labels]).toEqual([
      ["a", "loop · resume, plain · new"],
      ["b", "default · fork"],
    ]);
    expect(routeTransitionLabels(null).size).toBe(0);
  });
});

describe("transitionSessionEntriesFor", () => {
  const steps = [
    {
      stepId: "draft",
      transitionSessions: {
        revise: { mode: "resume" as const, step_id: "draft" },
      },
    },
    {
      stepId: "check",
      transitionSessions: { revise: { mode: "fork" as const, step_id: null } },
    },
  ];

  it("separates transitions entering the step from those continuing its conversation", () => {
    expect(
      transitionSessionEntriesFor("revise", steps).map((entry) => [
        entry.fromStepId,
        entry.decision.label,
        entry.decision.session,
        entry.role,
      ])
    ).toEqual([
      [
        "draft",
        "transition",
        { mode: "resume", stepId: "draft" },
        "destination",
      ],
      ["check", "transition", { mode: "fork", stepId: null }, "destination"],
    ]);
    expect(
      transitionSessionEntriesFor("draft", steps).map((entry) => [
        entry.fromStepId,
        entry.decision.targetStepId,
        entry.role,
      ])
    ).toEqual([["draft", "revise", "source"]]);
    expect(transitionSessionEntriesFor("z", steps)).toEqual([]);
  });
});

describe("transitionSessionLabels", () => {
  it("names the mode, and the continued step when it is not the target", () => {
    const labels = transitionSessionLabels(
      {
        b: { mode: "resume", step_id: "a" },
        c: { mode: "fork", step_id: "c" },
        d: { mode: "new", step_id: null },
      },
      (id) => id.toUpperCase()
    );
    expect([...labels]).toEqual([
      ["b", "resume · A"],
      ["c", "fork"],
      ["d", "new"],
    ]);
    expect(transitionSessionLabels(null, (id) => id).size).toBe(0);
  });
});

describe("childSessionEntriesFor", () => {
  it("lists the wait_children steps whose children fork the step", () => {
    expect(
      childSessionEntriesFor("plan", [
        { waitStepId: "wait", session: { mode: "fork", step_id: "plan" } },
        { waitStepId: "other", session: { mode: "fork", step_id: "review" } },
        { waitStepId: "plain", session: null },
      ])
    ).toEqual([
      {
        key: "wait:children:source",
        fromStepId: "wait",
        decision: {
          key: "children",
          label: "children",
          targetStepId: null,
          targetWorkflowId: null,
          session: { mode: "fork", stepId: "plan" },
        },
        role: "source",
      },
    ]);
  });
});
