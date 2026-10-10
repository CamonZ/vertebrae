import { describe, expect, it } from "vitest";
import {
  routeDecisions,
  routeTransitionLabels,
  sessionEntriesFor,
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
